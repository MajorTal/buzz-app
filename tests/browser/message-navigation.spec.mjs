import { test, expect } from "./fixture.mjs";
import { open, end, settle } from "./timeline.mjs";

test.use({ pluginFixtures: true, exactMessages: true });
const thread = (page) =>
  page.getByRole("region", { name: "Thread messages", exact: true });
const target = (app, id = app.exact.target.id) => ({
  version: 1,
  kind: "conversation",
  channelId: "alpha",
  messageId: id,
  scope: {
    viewer: app.viewer,
    communityOrigin: "https://primary.example",
  },
  threadRootId: "f".repeat(64),
});
const status = (page) =>
  page.evaluate(() => window.fixtureNavigation.snapshot().status);
async function openTarget(page, value) {
  return page.evaluate((value) => window.fixtureNavigation.open(value), value);
}

test("old root and reply beyond the first thread page open exactly; reclick and Back reveal again", async ({
  page,
  app,
}) => {
  await open(page, app);
  const initialHeadQueries = app.report.queries.filter(
    (q) => q.filter.top_level,
  ).length;
  // This navigation fixture deliberately registers a catch-all panel first.
  // Disable it before exercising the actual Profiles provider.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Notes fixture", exact: true })
    .click();
  for (const [mode, id] of [
    ["cold root", app.exact.root.id],
    ["cold reply", app.exact.target.id],
    ["warm reply", app.exact.target.id],
  ]) {
    const start = performance.now();
    expect(await openTarget(page, target(app, id))).toEqual({
      status: "opened",
    });
    app.report.measurements.push({
      mode,
      clickToOpenedMs: performance.now() - start,
    });
    const row = thread(page).locator(`[data-message-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toBeFocused();
    expect(await status(page)).toBe("opened");
    if (id === app.exact.target.id) {
      await expect(row).toContainText("Exact reply edited");
      await expect(
        row.locator("strong").filter({ hasText: "Exact reply edited" }),
      ).toHaveText("Exact reply edited");
      await expect(
        row.getByRole("button", {
          name: "View Alice Fixture profile",
          exact: true,
        }),
      ).toHaveCount(0); // Edited-body names cannot inherit original signed recipients.
      await expect(thread(page).locator("[data-message-id]")).toHaveCount(81);
      await expect(
        page.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
    }
  }
  expect(app.report.queries.filter((q) => q.filter.top_level).length).toBe(
    initialHeadQueries,
  );
  expect(app.report.queries.some((q) => q.filter.depth_limit)).toBe(true);
  expect(app.report.queries.filter((q) => q.filter.until)).toHaveLength(0);
  // Use an unedited reply to exercise exact mention/profile identity plumbing.
  expect(
    await openTarget(page, target(app, app.exact.replies.at(-2).id)),
  ).toEqual({ status: "opened" });
  const mention = thread(page)
    .locator(`[data-message-id="${app.exact.replies.at(-2).id}"]`)
    .getByRole("button", {
      name: "View Alice Fixture profile",
      exact: true,
    });
  await mention.click();
  await expect(
    page.getByRole("region", { name: "Profile details" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close channel panel", exact: true })
    .click();
  // Opening a panel retires the navigation-owned thread so the rail continues
  // to hold one surface. A fresh navigation can open another exact target.
  await expect(thread(page)).toHaveCount(0);
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(
    thread(page).locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toBeFocused();
  await expect.poll(() => status(page)).toBe("opened");
});

test("loaded virtual rows reveal per attempt without thread reads or live-update focus theft", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = page.getByRole("region", {
    name: "Channel message history",
    exact: true,
  });
  const id = app.histories.get("primary/alpha").at(-18).id;
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = performance.now();
    expect(await openTarget(page, target(app, id))).toEqual({
      status: "opened",
    });
    const row = history.locator(`[data-message-id="${id}"]`);
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    app.report.measurements.push({
      mode: `loaded timeline attempt ${attempt}`,
      clickToOpenedMs: performance.now() - start,
    });
    await composer.focus();
    await end(page);
  }
  expect(app.report.queries.filter((q) => q.filter.depth_limit)).toHaveLength(
    0,
  );
  await expect(thread(page)).toHaveCount(0);
  app.append("primary", "alpha", "Live after exact timeline reveal");
  await expect(history).toContainText("Live after exact timeline reveal");
  await expect(composer).toBeFocused();
});

test("an accessible exact reply stays visible without its root or a thread composer", async ({
  page,
  app,
}) => {
  app.histories.set(
    "primary/alpha",
    app.histories
      .get("primary/alpha")
      .filter((event) => event.id !== app.exact.root.id),
  );
  await open(page, app);
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  await expect(
    thread(page).locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toBeFocused();
  await expect(
    thread(page).getByText("Original message unavailable."),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("exact reply reveals before slow surrounding traversal and keeps its position afterwards", async ({
  page,
  app,
}) => {
  await open(page, app);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let intercepted;
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  let first = true;
  await page.route("**/api/relay/**/query", async (route) => {
    if (
      !first ||
      !route
        .request()
        .postDataJSON()
        .some((filter) => filter.depth_limit)
    )
      return route.continue();
    first = false;
    intercepted();
    await held;
    await route.continue().catch(() => {});
  });
  await page.evaluate((value) => {
    window.exactResult = window.fixtureNavigation.open(value);
  }, target(app));
  await seen;
  await expect.poll(() => status(page)).toBe("opened");
  const row = thread(page).locator(
    `[data-message-id="${app.exact.target.id}"]`,
  );
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
  const close = page.getByRole("button", { name: "Close thread", exact: true });
  await close.focus();
  release();
  await expect(thread(page).locator("[data-message-id]")).toHaveCount(81);
  await expect(row).toBeInViewport();
  await expect(close).toBeFocused();
});

test("unknown target fails without channel-head success and retries in the same visit", async ({
  page,
  app,
}) => {
  await open(page, app);
  expect(await openTarget(page, target(app, "e".repeat(64)))).toEqual({
    status: "failed",
    reason: "not-found",
  });
  await expect(
    page.getByRole("heading", { name: "This destination couldn’t open" }),
  ).toBeVisible();
  const visit = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry.id,
  );
  await page
    .getByRole("button", { name: "Retry navigation", exact: true })
    .click();
  await expect.poll(() => status(page)).toBe("failed");
  expect(
    await page.evaluate(() => window.fixtureNavigation.snapshot().entry.id),
  ).toBe(visit);
  await expect(thread(page).locator("[data-message-id]")).toHaveCount(0);
});

test("superseding a held exact read cancels it; a late response cannot steal focus or complete the next visit", async ({
  page,
  app,
}) => {
  await open(page, app);
  let release;
  let intercepted;
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!filters?.some((filter) => filter.ids?.includes(app.exact.target.id)))
      return route.continue();
    intercepted();
    await held;
    await route.fulfill({ json: [app.exact.target] }).catch(() => {});
  });
  await page.evaluate((value) => {
    window.exactResult = window.fixtureNavigation.open(value);
  }, target(app));
  await seen;
  expect(await status(page)).toBe("opening");
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  expect(await page.evaluate(() => window.exactResult)).toEqual({
    status: "superseded",
  });
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.focus();
  release();
  await expect(composer).toBeFocused();
  await expect(thread(page)).toHaveCount(0);
  await expect.poll(() => status(page)).toBe("opened");
});

test("same-scope replacement withdraws a held old session and reopens the exact row", async ({
  page,
  app,
}) => {
  await open(page, app);
  let release;
  let intercepted;
  const seen = new Promise((resolve) => {
    intercepted = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      !first ||
      !filters?.some((filter) => filter.ids?.includes(app.exact.target.id))
    )
      return route.continue();
    first = false;
    intercepted();
    await held;
    await route.fulfill({ json: [app.exact.target] }).catch(() => {});
  });
  await page.evaluate((value) => {
    window.exactResult = window.fixtureNavigation.open(value);
  }, target(app));
  await seen;
  const generation = await page.evaluate(() => {
    const generation = window.fixtureRelay.snapshot().generation;
    window.fixtureRelay.disconnect();
    return generation;
  });
  await expect(thread(page)).toHaveCount(0);
  await page.evaluate(() => window.fixtureRelay.retry());
  release();
  await expect(
    thread(page).locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toBeFocused();
  expect(
    await page.evaluate(() => window.fixtureRelay.snapshot().generation),
  ).toBeGreaterThan(generation);
  expect(await page.evaluate(() => window.exactResult)).toEqual({
    status: "opened",
  });
});

test("post-success membership loss removes the thread and live updates do not snap it back to the target", async ({
  page,
  app,
}) => {
  await open(page, app);
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  const region = thread(page);
  const channelButton = page.getByRole("button", {
    name: "Close thread",
    exact: true,
  });
  await channelButton.focus();
  const before = await region.evaluate((element) => element.scrollTop);
  app.edit(
    "primary",
    "alpha",
    { ...app.exact.target, created_at: app.exact.target.created_at + 10 },
    "Live edited exact reply",
  );
  await expect(region).toContainText("Live edited exact reply");
  await expect(channelButton).toBeFocused();
  expect(await region.evaluate((element) => element.scrollTop)).toBe(before);
  app.omitChannel("alpha");
  await page.getByLabel("Conversation options", { exact: true }).click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh channels", exact: true })
    .click();
  await expect(region).toHaveCount(0);
  await expect(
    page.locator(`[data-message-id="${app.exact.target.id}"]`),
  ).toHaveCount(0);
});

const readingTest = test.extend({ tallMessages: true });
readingTest(
  "exact thread navigation leaves the ordinary channel reading anchor unchanged",
  async ({ page, app }) => {
    const { settle, anchor, expectAnchor } = await import("./timeline.mjs");
    await open(page, app);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    await history.hover();
    await page.mouse.wheel(0, -650);
    await settle(page);
    const reading = await anchor(page);
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    await page
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(history).toBeVisible();
    await settle(page);
    await expectAnchor(page, reading);
  },
);

const readTest = test.extend({ productionBroker: true, readState: true });
test("bottom following keeps the final row fully visible after fractional reflow", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = page.getByRole("region", {
    name: "Channel message history",
    exact: true,
  });
  const row = history.locator(
    `[data-message-id="${app.histories.get("primary/alpha").at(-1).id}"]`,
  );
  // Text scaling and wrapping can produce fractional heights. Make the next
  // measurement fractional explicitly, independent of platform font metrics.
  const before = await history
    .locator("ol")
    .evaluate((e) => e.getBoundingClientRect().height);
  await row.evaluate((e, height) => {
    e.style.paddingBottom = `${Math.ceil(height) - height + 0.75}px`;
  }, before);
  await expect
    .poll(() =>
      history.locator("ol").evaluate((e) => e.getBoundingClientRect().height),
    )
    .toBe(Math.ceil(before) + 0.75);
  await expect
    .poll(() =>
      row.evaluate((e) => {
        const viewport = e
          .closest("[data-channel-timeline]")
          .getBoundingClientRect();
        const box = e.getBoundingClientRect();
        return box.top >= viewport.top && box.bottom <= viewport.bottom;
      }),
    )
    .toBe(true);
});
readTest(
  "exact reveal uses ordinary dwell rather than marking read at open",
  async ({ page, app }) => {
    await open(page, app);
    await page.evaluate(() =>
      window.fixtureRelay.snapshot().session.unread.ensure(),
    );
    const before = app.report.readPublications.length;
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    expect(app.report.readPublications.length).toBe(before);
    await expect
      .poll(() => app.report.readPublications.length)
      .toBeGreaterThan(before);
  },
);

const liveTest = test.extend({ productionBroker: true });
liveTest(
  "stream repair retains thread rows, reading position and composer focus after exact opening",
  async ({ page, app }) => {
    await open(page, app);
    await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    const region = thread(page);
    await expect(region.locator("[data-message-id]")).toHaveCount(81);
    await expect(region.getByText("Loading thread…")).toHaveCount(0);
    const readingRow = region.locator(
      `[data-message-id="${app.exact.replies[40].id}"]`,
    );
    await readingRow.scrollIntoViewIfNeeded();
    await region.dispatchEvent("wheel", { deltaY: -1 });
    const composer = page.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await composer.fill("Preserve my thread draft");
    await settle(page);
    const before = await region.evaluate((element) => element.scrollTop);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let intercepted;
    const seen = new Promise((resolve) => {
      intercepted = resolve;
    });
    let first = true;
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        !first ||
        !route
          .request()
          .postDataJSON()
          .some((filter) => filter.ids?.includes(app.exact.target.id))
      )
        return route.continue();
      first = false;
      intercepted();
      await held;
      await route.continue().catch(() => {});
    });
    app.relay.disconnect("primary");
    await seen;
    await expect(region.locator("[data-message-id]")).toHaveCount(81);
    await expect(composer).toBeFocused();
    expect(await region.evaluate((element) => element.scrollTop)).toBeCloseTo(
      before,
      0,
    );
    release();
    await expect(region.getByText("Loading thread…")).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty(
      "value",
      "Preserve my thread draft",
    );
    expect(await region.evaluate((element) => element.scrollTop)).toBeCloseTo(
      before,
      0,
    );
    await expect(readingRow).toBeInViewport();
  },
);

liveTest(
  "deleting the selected reply keeps valid thread context and exposes a local unavailable state",
  async ({ page, app }) => {
    await open(page, app);
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    const region = thread(page);
    await expect(region.locator("[data-message-id]")).toHaveCount(81);
    app.deleteTarget();
    await expect(
      region.locator(`[data-message-id="${app.exact.target.id}"]`),
    ).toHaveCount(0);
    await expect(
      region.locator(`[data-message-id="${app.exact.root.id}"]`),
    ).toBeAttached();
    await expect(region.locator("[data-message-id]")).toHaveCount(80);
    await expect(
      region.getByText("Selected message unavailable."),
    ).toBeVisible();
    await expect(region.getByText("Original message unavailable.")).toHaveCount(
      0,
    );
    await expect(
      region.getByRole("button", { name: "Retry thread", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeVisible();
  },
);
