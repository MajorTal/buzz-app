import { test, expect } from "./fixture.mjs";
import { open, settle, upper, expectAnchor, end, anchor } from "./timeline.mjs";

test.use({ productionBroker: true });
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const retry = (page) =>
  page.getByRole("button", { name: "Retry live updates", exact: true });
const heads = (app, channel) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter.kinds?.includes(9) &&
      filter["#h"]?.length === 1 &&
      filter["#h"][0] === channel &&
      filter.top_level === true &&
      filter.until === undefined,
  );
async function ready(page, app) {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  // The first head may already start after stream establishment; a duplicate
  // initial read is not required. Recovery below has its own positive gap control.
  await expect.poll(() => heads(app, "alpha").length).toBeGreaterThanOrEqual(1);
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  await expect(retry(page)).toHaveCount(0);
  await settle(page);
}

test("production WS → broker → mounted UI delivers messages and retries a paused catch-up without replacing healthy routes", async ({
  page,
  app,
}) => {
  await ready(page, app);
  const live = app.append("primary", "alpha", "Policy-realistic live delivery");
  await expect(
    history(page).locator(`[data-message-id="${live.id}"]`),
  ).toBeInViewport();
  const reading = await upper(page);
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .fill("Keep my draft");
  const socketCount = app.relay.sockets.length;
  const globalRequests = app.relay.requests.filter(
    ({ filter }) => !filter["#h"],
  ).length;
  app.relay.failRoute("primary", "alpha");
  const missed = app.append(
    "primary",
    "alpha",
    "Delivered by authoritative catch-up",
    false,
  );
  app.relay.quotaNextHead("alpha", 2);
  // A sidebar preview may reach the shared broker before the selected head.
  // It must not consume the failure injected specifically for head catch-up.
  const previewStatus = await page.evaluate(async () => {
    const response = await fetch("/api/relay/primary/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Buzz-Read-Priority": "background",
      },
      body: JSON.stringify([
        {
          "#h": ["alpha", "beta"],
          include_aux: true,
          kinds: [40002, 9],
          limit: 500,
        },
      ]),
    });
    return response.status;
  });
  expect(previewStatus).toBe(200);
  expect(app.relay.rejected).toHaveLength(0);
  await retry(page).click();
  await expect.poll(() => app.relay.rejected.length).toBe(1);
  await expect(
    page.getByRole("status").filter({ hasText: "rate-limited" }),
  ).toBeVisible();
  const calls = heads(app, "alpha").length;
  await retry(page).click();
  await retry(page).click();
  expect(heads(app, "alpha")).toHaveLength(calls);
  expect(app.relay.sockets).toHaveLength(socketCount);
  expect(app.relay.requests.filter(({ filter }) => !filter["#h"])).toHaveLength(
    globalRequests,
  );
  await expectAnchor(page, reading);
  await expect
    .poll(() => performance.now())
    .toBeGreaterThan(app.relay.rejected[0].until + 50);
  await retry(page).click();
  await expect(retry(page)).toHaveCount(0);
  await expect.poll(() => heads(app, "alpha").length).toBe(calls + 1);
  await settle(page);
  await expectAnchor(page, reading);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toHaveValue("Keep my draft");
  await end(page);
  await expect(
    history(page).locator(`[data-message-id="${missed.id}"]`),
  ).toBeInViewport();
  const after = app.append("primary", "alpha", "Live delivery still active");
  await expect(
    history(page).locator(`[data-message-id="${after.id}"]`),
  ).toBeInViewport();
});

test("post-reconnect finite catch-up keeps paged history, cursor and reading position", async ({
  page,
  app,
}) => {
  await ready(page, app);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  await settle(page);
  const before = await anchor(page);
  const pageOne = app.pending.shift();
  pageOne.release();
  await expect(
    history(page).locator(`[data-message-id="${pageOne.events[0].id}"]`),
  ).toBeAttached();
  await settle(page);
  await expectAnchor(page, before);
  const reading = await upper(page);
  const calls = heads(app, "alpha").length;
  app.relay.disconnect("primary");
  const missed = app.append(
    "primary",
    "alpha",
    "Reconnect gap repaired",
    false,
  );
  await expect.poll(() => heads(app, "alpha").length).toBeGreaterThan(calls);
  await expect(retry(page)).toHaveCount(0);
  await settle(page);
  await expectAnchor(page, reading);
  await history(page).hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => app.pending.length).toBe(1);
  const pageTwo = app.pending.shift();
  expect(pageTwo.filter.until).toBeLessThan(pageOne.filter.until);
  pageTwo.release();
  await end(page);
  await expect(
    history(page).locator(`[data-message-id="${missed.id}"]`),
  ).toBeInViewport();
});

test("Live retry recovers an empty paused roster without restarting healthy global subscriptions", async ({
  page,
  app,
}) => {
  // Empty is a valid authoritative result: recovery must not depend on a
  // selected channel or on an interest change replacing the global stream.
  app.relay.emptyRoster();
  app.relay.quotaNextRoster(2);
  await page.goto(app.origin);
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await expect.poll(() => app.relay.rejected.length).toBe(1);
  await expect(
    page.getByRole("status").filter({ hasText: "rate-limited" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  const globals = () =>
    app.relay.requests.filter(
      ({ filter }) => !filter["#h"] && !filter.kinds.includes(24200),
    );
  const observer = () =>
    app.relay.requests.filter(({ filter }) => filter.kinds.includes(24200));
  await expect.poll(() => globals().length).toBe(2);
  await expect.poll(() => observer().length).toBe(1);
  const sockets = app.relay.sockets.length;
  const rosters = () =>
    app.report.queries.filter(({ filter }) => filter.kinds?.includes(39002));
  const calls = rosters().length;
  await retry(page).click();
  await retry(page).click();
  expect(rosters()).toHaveLength(calls);
  await expect
    .poll(() => performance.now())
    .toBeGreaterThan(app.relay.rejected[0].until + 50);
  await retry(page).click();
  await expect(
    page.getByText("No channels yet.", { exact: true }),
  ).toBeVisible();
  await expect(retry(page)).toHaveCount(0);
  expect(rosters()).toHaveLength(calls + 1);
  expect(app.relay.sockets).toHaveLength(sockets);
  expect(globals()).toHaveLength(2);
  // The first authoritative (empty) roster resets activity's access generation.
  // Only its live-only route is renewed; healthy chat globals stay untouched.
  await expect.poll(() => observer().length).toBe(2);
  expect(observer()[1].filter.since).toBeGreaterThanOrEqual(
    observer()[0].filter.since,
  );
});
