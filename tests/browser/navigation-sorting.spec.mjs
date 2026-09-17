import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, savedSidebar: true, sortingSidebar: true });
// Native details/menu nesting, submenu focus/viewport placement and row reorder
// through the built app + real broker are browser contracts. Matrices live below.
test("section sort applies immediately, rolls back on failure, and persists retry independently", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const channels = sidebar.locator('[data-sidebar-section="channels"]');
  const work = sidebar.locator('[data-sidebar-section="group:work"]');
  const trigger = channels.getByRole("button", {
    name: "More actions for Channels",
  });
  const rows = channels.locator("[data-channel-id]");
  const order = () =>
    rows.evaluateAll((elements) => elements.map((el) => el.dataset.channelId));
  await expect(
    work.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(rows.first()).toBeVisible();
  const alphaOrder = await order();
  expect(alphaOrder.length).toBeGreaterThan(2);
  const activity = app.report.queries.filter((q) =>
    q.filter.kinds?.includes(45003),
  );
  expect(activity).toEqual([]);
  async function openSort() {
    await trigger.click();
    await expect(channels).toHaveAttribute("open", "");
    await page
      .getByRole("menu", { name: "More actions for Channels", exact: true })
      .getByRole("menuitem", { name: "Sort", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("menu", { name: "Sort", exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({
    path: testInfo.outputPath("sidebar-sort-alpha.png"),
    clip: { x: 0, y: 0, width: 540, height: 460 },
  });
  await openSort();
  const menu = page.getByRole("menu", { name: "Sort", exact: true });
  await expect(
    menu.getByRole("menuitemradio", { name: "A–Z" }),
  ).toHaveAttribute("aria-checked", "true");
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/sidebar-sort", async (route) => {
    started();
    await held;
    app.report.sidebarSortFailures ??= [];
    app.report.sidebarSortFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "sort save failed" }),
    });
  });
  try {
    await menu.getByRole("menuitemradio", { name: "Recent" }).click();
    await requestStarted;
    await expect(menu.getByRole("status")).toHaveText("Saving…");
    await expect(
      menu.getByRole("menuitemradio", { name: "Recent" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect.poll(order).not.toEqual(alphaOrder);
  } finally {
    release();
  }
  await expect(menu.getByRole("alert")).toHaveText(
    "Relay request failed (502)",
  );
  await expect.poll(order).toEqual(alphaOrder);
  await page.unroute("**/sidebar-sort");
  await menu.getByRole("menuitemradio", { name: "Recent" }).click();
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect.poll(order).not.toEqual(alphaOrder);
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-sort",
    blob: { groups: { channels: "recent" } },
  });
  const recentOrder = await order();
  await openSort();
  await expect(
    menu.getByRole("menuitemradio", { name: "Recent" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(menu).toHaveCSS("opacity", "1");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: testInfo.outputPath("sidebar-sort-menu.png"),
    clip: { x: 0, y: 0, width: 540, height: 460 },
  });
  const box = await menu.boundingBox(),
    viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("menu", { name: "More actions for Channels", exact: true }),
  ).not.toBeVisible();
  await work.getByRole("button", { name: "More actions for Work" }).click();
  await page
    .getByRole("menu", { name: "More actions for Work", exact: true })
    .getByRole("menuitem", { name: "Sort", exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  const workMenu = page.getByRole("menu", { name: "Sort", exact: true });
  await expect(
    workMenu.getByRole("menuitemradio", { name: "A–Z" }),
  ).toHaveAttribute("aria-checked", "true");
  await workMenu.getByRole("menuitemradio", { name: "Recent" }).click();
  await expect(workMenu).not.toBeVisible();
  expect(app.report.sidebarPublications.at(-1).blob.groups).toEqual({
    channels: "recent",
    "section:work": "recent",
  });
  await expect.poll(order).toEqual(recentOrder);
  await openSort();
  await menu.getByRole("menuitemradio", { name: "A–Z" }).click();
  await expect(menu).not.toBeVisible();
  await expect.poll(order).toEqual(alphaOrder);
  expect(app.report.sidebarPublications.at(-1).blob.groups).toEqual({
    "section:work": "recent",
  });
  expect(app.report.unexpected).toEqual([]);
});
