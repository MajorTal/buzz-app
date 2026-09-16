import { test, expect } from "./fixture.mjs";
import { settle } from "./timeline.mjs";

// The production app's exact-reader -> DOM focus/visibility -> navigation
// completion boundary requires real layout and both browser engines.
test.use({
  pluginFixtures: true,
  exactMessages: true,
  sessionChannels: ["alpha"],
  historyCounts: { alpha: 90, beta: 5 },
});
const target = (app, messageId, threadRootId) => ({
  version: 1,
  kind: "conversation",
  channelId: "alpha",
  scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
  ...(messageId ? { messageId } : {}),
  ...(threadRootId ? { threadRootId } : {}),
});
const openTarget = (page, value) =>
  page.evaluate((target) => window.fixtureNavigation.open(target), value);
const history = (page) =>
  page.getByRole("region", { name: "Channel message history", exact: true });
const selected = (page) =>
  page.getByRole("region", { name: "Selected session message", exact: true });

test("older session root and reply links fetch and reveal inline, then sending returns to latest", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  await expect(
    history(page).locator(`[data-message-id="${app.exact.root.id}"]`),
  ).toHaveCount(0);
  for (const [mode, id] of [
    ["cold root", app.exact.root.id],
    ["cold reply", app.exact.target.id],
    ["warm reply", app.exact.target.id],
  ]) {
    const start = performance.now();
    expect(
      await openTarget(
        page,
        target(app, id, mode === "cold root" ? id : app.exact.root.id),
      ),
    ).toEqual({ status: "opened" });
    app.report.measurements.push({
      mode,
      clickToOpenedMs: performance.now() - start,
    });
    const row = selected(page).locator(`[data-message-id="${id}"]`);
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    await expect(selected(page).locator("[data-message-id]")).toHaveCount(1);
    await expect(
      page.getByRole("complementary", { name: "Thread", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toHaveCount(0);
    expect(
      app.report.queries.some(({ filter }) => filter.ids?.includes(id)),
    ).toBe(true);
    if (id === app.exact.target.id)
      await expect(row).toContainText("Exact reply edited");
    if (mode !== "warm reply") {
      await page
        .getByRole("button", { name: "Back to latest", exact: true })
        .click();
      await expect(history(page)).toBeVisible();
      await expect(selected(page)).toHaveCount(0);
    }
  }
  const composer = page.getByRole("textbox", {
    name: "Message this session",
    exact: true,
  });
  await composer.fill("Continue the session from an older link");
  await composer.press("Enter");
  await expect(
    history(page).getByText("Continue the session from an older link", {
      exact: true,
    }),
  ).toBeInViewport();
  await expect(selected(page)).toHaveCount(0);
});

test("a loaded session reply reveals in the existing timeline without an exact lookup", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  await expect(history(page)).toBeVisible();
  await settle(page);
  const reply = app.append(
    "primary",
    "alpha",
    "Loaded session reply",
    true,
    true,
    app.exact.root.id,
  );
  await expect(
    history(page).locator(`[data-message-id="${reply.id}"]`),
  ).toBeVisible();
  await settle(page);
  const reads = app.report.queries.filter(({ filter }) =>
    filter.ids?.includes(reply.id),
  ).length;
  expect(
    await openTarget(page, target(app, reply.id, app.exact.root.id)),
  ).toEqual({ status: "opened" });
  await expect(
    history(page).locator(`[data-message-id="${reply.id}"]`),
  ).toBeFocused();
  await expect(selected(page)).toHaveCount(0);
  expect(
    app.report.queries.filter(({ filter }) => filter.ids?.includes(reply.id)),
  ).toHaveLength(reads);
});
