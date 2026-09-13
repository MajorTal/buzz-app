import { test, expect } from "./fixture.mjs";
import { settle, upper, expectAnchor } from "./timeline.mjs";

// Resize tests must not enter the fixture’s deliberately held paging path.
const readingTest = test.extend({ tallMessages: true });
async function expectNonPaging(page, app) {
  expect(
    await page
      .getByRole("region", { name: "Channel message history" })
      .evaluate((el) => el.scrollTop - Math.max(3000, el.clientHeight * 4)),
    "resize reading position stays outside older-page prefetch",
  ).toBeGreaterThan(0);
  expect(
    app.report.queries.filter(({ filter }) => filter.until !== undefined),
  ).toHaveLength(0);
}

const button = (page, name) => page.getByRole("button", { name, exact: true });
const box = async (locator) => {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds;
};
const near = (a, b) => expect(Math.abs(a - b)).toBeLessThan(2);
const panel = (page) =>
  page.getByRole("complementary", { name: "GitHub", exact: true });

async function open(page, app) {
  await page.goto(app.origin);
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Messages" })
    .click();
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
}
async function link(page, app, target) {
  await page.route("https://api.github.com/repos/block/buzz/pulls/*", (route) =>
    route.fulfill({
      json: {
        title: "A useful change",
        state: "open",
        user: { login: "Fixture Reader" },
        body: "Public fixture content.\n".repeat(100),
      },
    }),
  );
  app.append("primary", "alpha", `Please review ${target}`);
  await page.getByRole("link", { name: target, exact: true }).click();
  await expect(
    panel(page).getByRole("heading", { name: "A useful change" }),
  ).toBeVisible();
}
async function shellFits(page, width) {
  const tabs = await box(
    page.getByRole("navigation", { name: "Pages", exact: true }),
  );
  near(tabs.x + tabs.width / 2, width / 2);
  const actions = await box(page.locator(".shell-actions"));
  const communities = await box(button(page, "Switch community"));
  expect(actions.x + actions.width).toBeLessThanOrEqual(width);
  expect(communities.x + communities.width).toBeLessThan(actions.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    width,
  );
  if (width > 700) {
    expect(communities.x + communities.width).toBeLessThan(tabs.x);
    expect(tabs.x + tabs.width).toBeLessThan(actions.x);
  }
}

test("bento surfaces, centered tabs, real link panel and compact community navigation", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await open(page, app);
  await shellFits(page, 1280);
  const sidebar = await box(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  );
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const before = await box(conversation);
  near(sidebar.x, 16);
  near(before.x - sidebar.x - sidebar.width, 16);
  near(before.y, 56);
  near(before.height, 760);
  const background = await page
    .locator(".shell-background")
    .evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(background).toContain("radial-gradient");
  expect(background).toContain("/shell-gradient.png");
  expect(
    await page.evaluate(async () => {
      const image = new Image();
      image.src = "/shell-gradient.png";
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }),
  ).toEqual([564, 1002]);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Layout draft");
  await page.screenshot({ path: testInfo.outputPath("bento-no-panel.png") });
  await link(page, app, "https://github.com/block/buzz/pull/1");
  const main = await box(conversation);
  const dock = await box(panel(page));
  near(dock.y, main.y);
  near(dock.height, main.height);
  near(dock.x - main.x - main.width, 16);
  near(dock.x + dock.width, 1264);
  await expect(composer).toHaveValue("Layout draft");
  await expect(composer).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("bento-one-panel.png") });
  const timeline = page.getByRole("region", {
    name: "Channel message history",
  });
  const offset = await timeline.evaluate((el) => el.scrollTop);
  await panel(page).getByRole("heading", { name: "A useful change" }).hover();
  await page.mouse.wheel(0, 1000);
  await expect
    .poll(() =>
      panel(page)
        .locator("[class*='root']")
        .evaluate((el) => el.scrollTop),
    )
    .toBeGreaterThan(100);
  near(await timeline.evaluate((el) => el.scrollTop), offset);
  await button(page, "Close channel panel").click();
  await expect(panel(page)).toHaveCount(0);
  near((await box(conversation)).width, before.width);
  await link(page, app, "https://github.com/block/buzz/pull/2");
  await button(page, "Beta").click();
  await expect(panel(page)).toHaveCount(0);
  await button(page, "Alpha").click();
  await expect(composer).toHaveValue("Layout draft");
  await button(page, "Switch community").click();
  await expect(
    page.getByRole("dialog", { name: "Communities", exact: true }),
  ).toBeVisible();
  await expect(button(page, "Personal space")).toBeVisible();
  await expect(button(page, "Add a community")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button(page, "Switch community")).toBeFocused();
  await button(page, "Switch community").click();
  await button(page, "Add a community").click();
  await expect(
    page.getByRole("heading", { name: "Add a community", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(button(page, "Switch community")).toBeFocused();
  await button(page, "Switch community").click();
  await button(page, "Switch to Secondary").click();
  await expect(composer).toHaveValue("");
  await button(page, "Switch community").click();
  await button(page, "Switch to Primary").click();
  await expect(composer).toHaveValue("Layout draft");
  for (const [width, height] of [
    [1200, 800],
    [800, 600],
    [480, 400],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await shellFits(page, width);
    await expect(composer).toBeInViewport();
    await button(page, "Your profile").click();
    await button(page, "Settings").click();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Messages" })
      .click();
    await expect(composer).toHaveValue("Layout draft");
    await expect(page.locator("[data-message-id]").last()).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("bento-narrow.png") });
  await link(page, app, "https://github.com/block/buzz/pull/3");
  await expect(button(page, "Close channel panel")).toBeInViewport();
  const narrow = await box(panel(page));
  near(narrow.x, 8);
  near(narrow.width, 374);
  await button(page, "Close channel panel").click();
  await expect(composer).toBeInViewport();
  await button(page, "Find a page").click();
  await page
    .getByRole("dialog", { name: "Find a page" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Home" }),
  ).toHaveAttribute("aria-current", "page");
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toHaveValue("Browser Fixture");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await button(page, "Plugins").click();
  const channels = page.getByRole("switch", {
    name: "Enable Channels",
    exact: true,
  });
  await channels.click();
  await expect(channels).toHaveAttribute("aria-checked", "false");
  await expect(
    page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Messages" }),
  ).toHaveCount(0);
  await channels.click();
  await expect(channels).toHaveAttribute("aria-checked", "true");
  await expect(
    page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Messages" }),
  ).toBeVisible();
});

readingTest(
  "panel resizing preserves bottom follow and the visible reading anchor",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    await link(page, app, "https://github.com/block/buzz/pull/4");
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const expectBottom = () =>
      expect
        .poll(() =>
          history.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        )
        .toBeLessThan(4);
    await settle(page);
    await expectBottom();
    const received = app.append("primary", "alpha");
    await expect(
      page.locator(`[data-message-id="${received.id}"]`),
    ).toBeInViewport();
    await button(page, "Close channel panel").click();
    await settle(page);
    await expectBottom();
    // Late layout-only reflow must not need another message or viewport resize.
    // Let Virtua's 150ms imperative-scroll scheduler expire first. Change actual
    // row layout, not scroll methods/metrics or the production observer callback.
    await page.waitForTimeout(250);
    const lateLayout = await page.addStyleTag({
      content: `[data-message-id="${received.id}"] p { padding-bottom: 120px; }`,
    });
    await settle(page);
    await expectBottom();
    await page.waitForTimeout(250);
    await lateLayout.evaluate((element) => element.remove());
    await settle(page);
    await expectBottom();
    // Reopen by keyboard without browser click-to-scroll changing the saved position.
    const target = "https://github.com/block/buzz/pull/4";
    const saved = await upper(page);
    await expectNonPaging(page, app);
    await page
      .getByRole("link", { name: target, exact: true })
      .evaluate((el) => el.focus({ preventScroll: true }));
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    await settle(page);
    await expectAnchor(page, saved);
    // A panel can return focus to a mounted but offscreen link. Observe the
    // native focus call itself: eventual anchor recovery can hide a scroll jump.
    await page
      .getByRole("link", { name: target, exact: true })
      .evaluate((el) => {
        const focus = el.focus;
        el.focus = function (options) {
          const history = el.closest("[data-channel-timeline]");
          const before = history.scrollTop;
          focus.call(this, options);
          window.panelFocusScrollDelta = history.scrollTop - before;
        };
      });
    await button(page, "Close channel panel").focus();
    await button(page, "Close channel panel").click();
    const trigger = page.getByRole("link", { name: target, exact: true });
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.panelFocusScrollDelta)).toBe(0);
    await settle(page);
    await expectAnchor(page, saved);
    await page.setViewportSize({ width: 1200, height: 700 });
    await settle(page);
    await expectAnchor(page, saved);
    await expectNonPaging(page, app);
  },
);

test("Bestie owns the launcher and the reusable companion card across pages and disable", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.goto(app.origin);
  const bestie = page.getByRole("complementary", {
    name: "Bestie",
    exact: true,
  });
  const launch = button(page, "Bestie");
  await expect(launch).toBeVisible();
  await expect(bestie).toHaveCount(0);
  await launch.click();
  await expect(bestie).toBeVisible();
  await expect(bestie).toContainText("Agent chat isn’t connected yet");
  await expect(launch).toHaveAttribute("aria-expanded", "true");
  await launch.click();
  await expect(bestie).toHaveCount(0);
  await expect(launch).toHaveAttribute("aria-expanded", "false");
  await expect(launch).toBeFocused();
  await launch.click();
  await button(page, "Close Bestie panel").click();
  await expect(launch).toBeFocused();
  await launch.click();
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
  await expect(bestie).toHaveCount(1);
  const enabled = page.getByRole("switch", {
    name: "Enable Bestie",
    exact: true,
  });
  await enabled.click();
  await expect(launch).toHaveCount(0);
  await expect(bestie).toHaveCount(0);
  await expect(enabled).toBeFocused();
  await enabled.click();
  await expect(launch).toBeVisible();
  await expect(bestie).toHaveCount(0);
  await launch.click();
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Messages" })
    .click();
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.fill("Companion draft");
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  near((await box(bestie)).height, (await box(conversation)).height);
  await link(page, app, "https://github.com/block/buzz/pull/5");
  const top = await box(panel(page)),
    bottom = await box(bestie),
    main = await box(conversation);
  near(top.height, bottom.height);
  near(top.y, main.y);
  near(bottom.y - top.y - top.height, 12);
  near(bottom.y + bottom.height, main.y + main.height);
  near(top.x, bottom.x);
  await page.screenshot({ path: testInfo.outputPath("bestie-two-panels.png") });
  // Simulate a management update observed while Messages remains mounted.
  await page.evaluate(() => {
    const key = "buzzodz.plugins.v1";
    const settings = JSON.parse(localStorage.getItem(key));
    settings.enabled["buzz.bestie"] = false;
    localStorage.setItem(key, JSON.stringify(settings));
  });
  await expect(launch).toHaveCount(0);
  await expect(bestie).toHaveCount(0);
  await expect(panel(page)).toHaveCount(1);
  near((await box(panel(page))).height, (await box(conversation)).height);
  await page.evaluate(() => {
    const key = "buzzodz.plugins.v1";
    const settings = JSON.parse(localStorage.getItem(key));
    settings.enabled["buzz.bestie"] = true;
    localStorage.setItem(key, JSON.stringify(settings));
  });
  await expect(launch).toBeVisible();
  await expect(bestie).toHaveCount(0);
  await launch.click();
  await expect(composer).toHaveValue("Companion draft");
  await button(page, "Close Bestie panel").click();
  near((await box(panel(page))).height, (await box(conversation)).height);
  await launch.click();
  await button(page, "Close channel panel").click();
  near((await box(bestie)).height, (await box(conversation)).height);
  await button(page, "Beta").click();
  await expect(bestie).toHaveCount(1);
  await button(page, "Alpha").click();
  await expect(composer).toHaveValue("Companion draft");
  await button(page, "Switch community").click();
  await button(page, "Personal space").click();
  await expect(
    page.getByRole("heading", { name: "Your channels, one conversation." }),
  ).toBeVisible();
  await expect(bestie).toHaveCount(1);
  await button(page, "Close Bestie panel").click();
  await launch.click();
  await expect(bestie).toHaveCount(1);
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
  await page
    .getByRole("switch", { name: "Enable Channels", exact: true })
    .click();
  await expect(bestie).toHaveCount(1);
  for (const [width, height] of [
    [800, 600],
    [480, 400],
    [390, 844],
    [390, 400],
  ]) {
    await page.setViewportSize({ width, height });
    await shellFits(page, width);
    await expect(button(page, "Close Bestie panel")).toBeInViewport();
  }
  await button(page, "Close Bestie panel").click();
  await expect(bestie).toHaveCount(0);
  await expect(launch).toHaveAttribute("aria-expanded", "false");
  await expect(launch).toBeFocused();

  // Plugin catalogs can outgrow the viewport. Closing restores the launcher,
  // not a Settings row: reach the toggle with real input, not scrollIntoView.
  const settingsPage = page.getByRole("main").locator(".overflow-y-auto");
  await expect(enabled).not.toBeInViewport();
  const viewport = await box(settingsPage);
  await page.mouse.move(
    viewport.x + viewport.width / 2,
    viewport.y + viewport.height / 2,
  );
  for (let gesture = 0; gesture < 4; gesture++) {
    const toggle = await box(enabled);
    if (
      toggle.y >= viewport.y &&
      toggle.y + toggle.height <= viewport.y + viewport.height
    )
      break;
    const before = await settingsPage.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, viewport.height * 0.75);
    await expect
      .poll(() => settingsPage.evaluate((el) => el.scrollTop), {
        message: "Settings wheel input makes progress toward the plugin toggle",
      })
      .toBeGreaterThan(before);
  }
  await expect(enabled).toBeInViewport({ ratio: 1 });
  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await expect(enabled).toBeFocused();
  await expect(launch).toHaveCount(0);
});

readingTest(
  "companion resize preserves the timeline anchor and both cards at narrow sizes",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const saved = await upper(page);
    await expectNonPaging(page, app);
    await button(page, "Bestie").click();
    await settle(page);
    await expectAnchor(page, saved);
    await button(page, "Close Bestie panel").click();
    await settle(page);
    await expectAnchor(page, saved);
    await link(page, app, "https://github.com/block/buzz/pull/6");
    await button(page, "Bestie").click();
    for (const [width, height] of [
      [800, 600],
      [480, 400],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const top = await box(panel(page));
      const bottom = await box(
        page.getByRole("complementary", { name: "Bestie", exact: true }),
      );
      near(top.height, bottom.height);
      near(bottom.y - top.y - top.height, 12);
      await expect(button(page, "Close channel panel")).toBeInViewport();
      await expect(button(page, "Close Bestie panel")).toBeInViewport();
    }
  },
);

readingTest(
  "panel restoration yields to a new wheel reading position",
  async ({ page, app }) => {
    await open(page, app);
    await settle(page);
    const original = await upper(page);
    await button(page, "Bestie").click();
    await settle(page);
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const before = await history.evaluate((el) => el.scrollTop);
    await history.hover();
    await page.mouse.wheel(0, -300);
    await expect
      .poll(() => history.evaluate((el) => el.scrollTop))
      .toBeLessThan(before);
    await settle(page);
    // A tall paragraph need not fit wholly in the narrowed viewport. Capture
    // the visible reading row, including the production clipped-row fallback.
    const reading = await history.evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      const rows = Array.from(el.querySelectorAll("[data-message-id]"));
      const row =
        rows.find((row) => {
          const p = row.querySelector("p").getBoundingClientRect();
          return p.top >= bounds.top && p.bottom <= bounds.bottom;
        }) ??
        rows.find((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
      if (!row) throw new Error("No visible post-gesture reading row");
      return {
        id: row.dataset.messageId,
        y: row.querySelector("p").getBoundingClientRect().top - bounds.top,
      };
    });
    expect(reading.id).not.toBe(original.id);
    await button(page, "Close Bestie panel").click();
    await settle(page);
    await expectAnchor(page, reading);
    await expectNonPaging(page, app);
  },
);

test("Projects stays centered and page navigation survives plugin re-enable order", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.goto(app.origin);
  const nav = page.getByRole("navigation", { name: "Pages", exact: true });
  const titles = ["Home", "Messages", "Projects", "Agents"];
  await expect(nav.getByRole("button")).toHaveText(titles);
  await nav.getByRole("button", { name: "Projects", exact: true }).click();
  const surface = page.getByRole("region", { name: "Projects", exact: true });
  const title = surface.getByRole("heading", {
    name: "Projects",
    level: 1,
    exact: true,
  });
  await expect(title).toBeVisible();
  await expect(surface).toHaveText("Projects");
  for (const [width, height] of [
    [1280, 832],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    const bounds = await box(surface);
    const workspace = await box(surface.locator("..").locator(".."));
    const heading = await box(title);
    near(bounds.x, workspace.x);
    near(bounds.y, workspace.y);
    near(bounds.width, workspace.width);
    near(bounds.height, workspace.height);
    near(heading.x + heading.width / 2, bounds.x + bounds.width / 2);
    near(heading.y + heading.height / 2, bounds.y + bounds.height / 2);
    await expect(surface).toHaveCSS("overflow", "hidden");
    await shellFits(page, width);
    await page.screenshot({
      path: testInfo.outputPath(`projects-${width}.png`),
    });
  }
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
  const projects = page.getByRole("switch", {
    name: "Enable Projects",
    exact: true,
  });
  await projects.click();
  await expect(nav.getByRole("button")).toHaveText([
    "Home",
    "Messages",
    "Agents",
  ]);
  await projects.click();
  await expect(nav.getByRole("button")).toHaveText(titles);
  // Leave registration order reversed so every navigation surface must sort it.
  const channels = page.getByRole("switch", {
    name: "Enable Channels",
    exact: true,
  });
  await channels.click();
  await expect(nav.getByRole("button")).toHaveText([
    "Home",
    "Projects",
    "Agents",
  ]);
  await channels.click();
  await expect(nav.getByRole("button")).toHaveText(titles);
  await nav.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("main").getByRole("button")).toHaveText([
    "Messages",
    "Projects",
    "Agents",
    "Make it yoursSettings",
  ]);
  await button(page, "Find a page").click();
  const search = page.getByRole("dialog", { name: "Find a page", exact: true });
  await expect(search.getByRole("button")).toHaveText([
    "",
    ...titles,
    "Settings",
  ]);
  await search.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(title).toBeVisible();
});
