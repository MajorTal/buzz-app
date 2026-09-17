import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, savedSidebar: true });

test("row menu moves and removes a channel through the confirmed saved-group writer", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  const work = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Work$/ }) });
  const channels = sidebar
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Channels$/ }) });
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();

  await work
    .getByRole("button", { name: "Beta", exact: true })
    .click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Beta" });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitemradio", { name: "Work" }),
  ).toHaveAttribute("aria-checked", "true");
  // The legacy non-UUID fixture has no lifecycle authority; its retry is the final item.
  await expect(
    menu.getByRole("menuitem", { name: "Retry channel permissions" }),
  ).toBeVisible();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Retry channel permissions" }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    menu.getByRole("menuitem", { name: "Star", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Work" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Remove from group" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    channels.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveCount(0);
  await expect(
    channels.getByRole("button", { name: "Beta", exact: true }),
  ).toBeFocused();
  expect(app.report.sidebarPublications).toHaveLength(1);
  expect(app.report.sidebarPublications[0].blob.assignments).toEqual({});

  await channels
    .getByRole("button", { name: "Beta", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitemradio", { name: "Work" }).click();
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(
    channels.getByRole("button", { name: "Beta", exact: true }),
  ).toHaveCount(0);
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toBeFocused();
  expect(app.report.sidebarPublications).toHaveLength(2);
  expect(app.report.sidebarPublications[1].blob.assignments).toEqual({
    beta: "work",
  });
  expect(app.report.unexpected).toEqual([]);
});

// Real context-menu keyboard/focus, viewport placement and row relocation require
// a browser. Intent validation, concurrency and persistence matrices stay below.
test("Star and Unstar retain the assigned group, keep one row, and recover from a failed save", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const work = sidebar.locator('[data-sidebar-section="group:work"]');
  const starred = sidebar.locator('[data-sidebar-section="starred"]');
  const beta = work.getByRole("button", { name: "Beta", exact: true });
  await expect(beta).toBeVisible();
  await starred.locator("summary").click();
  await expect(starred).not.toHaveAttribute("open", "");
  await beta.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Actions for Beta" });
  await expect(menu).toBeVisible();
  await menu.screenshot({ path: testInfo.outputPath("group-star-menu.png") });
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
  await page.keyboard.press("ContextMenu");
  await expect(menu).toBeVisible();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/sidebar-star", async (route) => {
    started();
    await held;
    app.report.sidebarStarFailures ??= [];
    app.report.sidebarStarFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Star save failed; retry" }),
    });
  });
  try {
    await menu.getByRole("menuitem", { name: "Star", exact: true }).click();
    await requestStarted;
    await expect(menu.getByRole("status")).toHaveText("Saving…");
    await expect(
      menu.getByRole("menuitem", { name: "Star", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
      page.locator(
        '[data-sidebar-section="group:work"] [data-channel-id="beta"]',
      ),
    ).toBeVisible();
  } finally {
    release();
  }
  await expect(
    menu.getByRole("alert").filter({ hasText: "Relay request failed" }),
  ).toHaveText("Relay request failed (502)");
  await expect(
    menu.getByRole("menuitem", { name: "Star", exact: true }),
  ).toBeEnabled();
  await page.unroute("**/sidebar-star");
  await page.keyboard.press("Home");
  await expect(
    menu.getByRole("menuitem", { name: "Star", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const relocated = starred.getByRole("button", { name: "Beta", exact: true });
  await expect(relocated).toBeVisible();
  await expect(relocated).toBeFocused();
  await sidebar.screenshot({ path: testInfo.outputPath("group-starred.png") });
  await expect(sidebar.locator('[data-channel-id="beta"]')).toHaveCount(1);
  expect(app.report.sidebarPublications).toHaveLength(1);
  expect(app.report.sidebarPublications[0]).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { alpha: { starred: true }, beta: { starred: true } } },
  });

  // Work is absent while its only row is starred. Unstar must restore it.
  await relocated.click({ button: "right" });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await menu.getByRole("menuitem", { name: "Unstar", exact: true }).click();
  await expect(beta).toBeVisible();
  await expect(beta).toBeFocused();
  await expect(sidebar.locator('[data-channel-id="beta"]')).toHaveCount(1);
  expect(app.report.sidebarPublications).toHaveLength(2);
  expect(app.report.sidebarPublications[1]).toMatchObject({
    coordinate: "channel-stars",
    blob: { channels: { alpha: { starred: true }, beta: { starred: false } } },
  });
  expect(app.report.unexpected).toEqual([]);
});

test.use({
  productionBroker: true,
  savedSidebar: true,
  largeSidebar: true,
  developmentReact: true,
});
test("Home → Messages keeps saved groups and scroll on every visible frame without re-decoding", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  await expect(sidebar.locator("summary", { hasText: /^Work$/ })).toBeVisible();
  await expect(
    sidebar.locator("summary", { hasText: /Starred$/ }),
  ).toBeVisible();
  const scroll = await sidebar.evaluate((element) => {
    element.scrollTop = 1000;
    return element.scrollTop;
  });
  expect(scroll).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await expect(sidebar).toHaveCount(0);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let decodes = 0;
  await page.route("**/sidebar-preferences", async (route) => {
    decodes++;
    await held;
    await route.continue();
  });
  await page.evaluate(() => {
    window.sidebarFrames = [];
    window.captureSidebar = true;
    const frame = () => {
      const list = document.querySelector(
        'nav[aria-label="Subscribed channels"]',
      );
      if (list)
        window.sidebarFrames.push({
          top: list.scrollTop,
          groups: Array.from(list.querySelectorAll("summary"), (el) =>
            el.textContent.replace("★", "").trim(),
          ),
        });
      if (window.captureSidebar) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  try {
    await page
      .getByRole("button", { name: "Messages", exact: true })
      .first()
      .click();
    await expect(sidebar).toBeVisible();
    await page.waitForTimeout(300); // Keep the decode path held for the full interval.
    // Wall time does not guarantee RAF callbacks on a busy runner. Wait for
    // samples, not correct samples: every earlier frame stays in the assertion.
    await page.waitForFunction(() => window.sidebarFrames.length > 3);
    const frames = await page.evaluate(() => {
      window.captureSidebar = false;
      return window.sidebarFrames;
    });
    expect(frames.length).toBeGreaterThan(3);
    expect(
      frames.filter(
        (frame) =>
          !frame.groups.includes("Work") ||
          !frame.groups.includes("Starred") ||
          Math.abs(frame.top - scroll) > 1,
      ),
      "No fallback grouping or top-of-list frame on warm return",
    ).toEqual([]);
    expect(
      decodes,
      "Remount must reuse the engine snapshot, not fetch/decode again",
    ).toBe(0);
  } finally {
    release();
    await page.unroute("**/sidebar-preferences");
  }
});
