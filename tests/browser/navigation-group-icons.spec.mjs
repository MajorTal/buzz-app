import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

const channelName = "buzz-tiptap-view-dom-crash";
test.use({
  productionBroker: true,
  savedSidebar: true,
  sidebarIcons: true,
  channelNames: { beta: channelName },
});

// Real catalog → session media URL → sidebar/menu image; browser layout owns
// loading placeholders and single-line dialog truncation, not a DOM emulator.
test("group icons resolve custom media without overlapping labels, and the create dialog stays one line", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  let release, started;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/media?*", async (route) => {
    started();
    await held;
    const url = new URL(route.request().url());
    expect(url.origin).toBe(app.origin);
    expect(url.searchParams.get("url")).toBe(
      "https://primary.example/media/stamp.png",
    );
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>',
    });
  });
  const section = page.locator('[data-sidebar-section="group:work"]');
  const headerIcon = section.locator("summary img");
  try {
    await open(page, app);
    await requested;
    const placeholder = section.locator("summary span[data-loading]");
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toHaveCSS("width", "16px");
    await expect(placeholder).toHaveCSS("height", "16px");
    await expect(placeholder).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(headerIcon).toBeHidden();
    await expect(section.locator("summary")).not.toContainText(":stamp:");
    await section
      .locator("summary")
      .screenshot({ path: testInfo.outputPath("group-icon-loading.png") });
  } finally {
    release();
  }
  await expect(headerIcon).toBeVisible();
  await expect
    .poll(() =>
      headerIcon.evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await expect(section.locator("summary [data-loading]")).toHaveCount(0);
  for (const key of ["work", "laptop"]) {
    const summary = page.locator(
      `[data-sidebar-section="group:${key}"] summary`,
    );
    const layout = await summary.evaluate((element) => {
      const icon = element.querySelector("[data-sidebar-group-icon]");
      const title = document.createRange();
      title.selectNodeContents(icon.nextSibling);
      const iconBounds = icon.getBoundingClientRect();
      const summaryBounds = element.getBoundingClientRect();
      return {
        gap: title.getBoundingClientRect().left - iconBounds.right,
        height: summaryBounds.height,
        iconTop: iconBounds.top,
        iconBottom: iconBounds.bottom,
        summaryTop: summaryBounds.top,
        summaryBottom: summaryBounds.bottom,
      };
    });
    expect(layout.gap).toBe(8);
    expect(layout.height).toBe(28);
    expect(layout.iconTop).toBeGreaterThanOrEqual(layout.summaryTop);
    expect(layout.iconBottom).toBeLessThanOrEqual(layout.summaryBottom);
  }
  await page
    .locator('[data-sidebar-section="group:laptop"] summary')
    .screenshot({
      path: testInfo.outputPath("group-emoji-spacing.png"),
    });
  const row = section.locator('[data-channel-id="beta"]');
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const move = page.getByRole("menuitem", {
    name: "Move channel",
    exact: true,
  });
  const icon = move.locator(".buzz-menu-icon svg");
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(icon).toHaveCSS("width", "14px");
  await expect(icon).toHaveCSS("height", "14px");
  await expect(move.locator(".buzz-menu-submenu-arrow")).toBeVisible();
  await move.focus();
  await page.keyboard.press("ArrowRight");
  const menu = page.getByRole("menu", { name: "Move channel", exact: true });
  const work = menu.getByRole("menuitemradio", { name: "Work", exact: true });
  await expect(work.locator("img")).toBeVisible();
  await expect
    .poll(() =>
      work
        .locator("img")
        .evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  const fallback = menu
    .getByRole("menuitemradio", { name: "Unavailable", exact: true })
    .locator("[data-sidebar-group-icon]");
  await expect(fallback).toBeEmpty();
  await expect(fallback.locator("[data-loading]")).toHaveCount(0);
  await expect(menu).not.toContainText(":stamp:");
  await expect(menu).not.toContainText(":unavailable_icon:");
  await expect(menu.locator("[title]")).toHaveCount(0);
  for (const item of [
    work,
    menu.getByRole("menuitemradio", { name: "Unavailable", exact: true }),
  ]) {
    const bounds = await item.evaluate((element) => {
      const icon = element.querySelector("[data-sidebar-group-icon]");
      const label = element.querySelector(".buzz-menu-choice-label").lastChild;
      const range = document.createRange();
      range.selectNodeContents(label);
      return {
        iconRight: icon.getBoundingClientRect().right,
        labelLeft: range.getBoundingClientRect().left,
      };
    });
    expect(bounds.iconRight).toBeLessThanOrEqual(bounds.labelLeft);
  }
  await page.screenshot({
    path: testInfo.outputPath("custom-group-menu.png"),
    clip: { x: 0, y: 0, width: 600, height: 520 },
  });
  await menu
    .getByRole("menuitem", { name: "Create new…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create new section" });
  const field = dialog.getByRole("textbox", {
    name: "Section name",
    exact: true,
  });
  await expect(field).toBeFocused();
  await expect(dialog.locator("label")).toHaveCount(0);
  await expect(dialog.locator("p")).toHaveText(
    `Move ${channelName} into a new section.`,
  );
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 950 });
    const layout = await dialog.locator("p").evaluate((element) => {
      const name = element.querySelector("span[title]");
      const range = document.createRange();
      range.selectNodeContents(name);
      const box = element.getBoundingClientRect();
      return {
        height: box.height,
        nameHeight: range.getBoundingClientRect().height,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        right: box.right,
        viewport: window.innerWidth,
      };
    });
    expect(layout.height).toBeLessThan(layout.nameHeight * 2);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport);
  }
  await dialog.screenshot({
    path: testInfo.outputPath("create-section-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  await dialog.screenshot({
    path: testInfo.outputPath("create-section-single-line.png"),
  });
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
});

// Real browser layout owns overflow detection, fading, and control alignment.
test("section labels fade on overflow and recover when widened", async ({
  page,
  app,
}, info) => {
  await page.route("**/media?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>',
    }),
  );
  await open(page, app);
  const sidebar = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  const row = sidebar.locator('[data-channel-id="beta"]');
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Move channel", exact: true })
    .hover();
  await page
    .getByRole("menuitem", { name: "Create new…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create new section" });
  const name = "Interface gang collaboration";
  await dialog.getByRole("textbox", { name: "Section name" }).fill(name);
  await dialog.getByRole("button", { name: "Create and move" }).click();
  const summary = sidebar.locator("summary").filter({ hasText: name });
  await expect(summary).toBeVisible();
  await sidebar.evaluate((element) => {
    element.closest(".shell-sidebar").style.width = "220px";
  });
  await summary.hover();
  await expect
    .poll(() =>
      summary.evaluate((element) => {
        const title = element.querySelector("span > span");
        const label = title.parentElement;
        const rect = title.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const actions = element
          .closest("details")
          .nextElementSibling.getBoundingClientRect();
        return {
          wrapped:
            rect.height > Number.parseFloat(getComputedStyle(title).lineHeight),
          fits: title.scrollWidth <= title.clientWidth,
          visible: rect.left >= labelRect.left && rect.right <= labelRect.right,
          clearOfActions: rect.right <= actions.left,
        };
      }),
    )
    .toEqual({
      wrapped: false,
      fits: false,
      visible: true,
      clearOfActions: true,
    });
  const title = summary.locator("span > span");
  await expect(title).toHaveAttribute("data-overflowing", "true");
  await expect(title).toHaveCSS("mask-image", /linear-gradient/);
  for (const width of [220, 260]) {
    await sidebar.evaluate((element, width) => {
      element.closest(".shell-sidebar").style.width = `${width}px`;
    }, width);
    await expect
      .poll(() =>
        summary.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const center = bounds.top + bounds.height / 2;
          const chevron = element.lastElementChild.getBoundingClientRect();
          const buttons = [
            ...element
              .closest("details")
              .nextElementSibling.querySelectorAll("button"),
          ].map((button) => button.getBoundingClientRect());
          return {
            centered: [chevron, ...buttons].every(
              (rect) => Math.abs(rect.top + rect.height / 2 - center) < 0.5,
            ),
            spacing:
              buttons[1].left +
              buttons[1].width / 2 -
              buttons[0].left -
              buttons[0].width / 2,
            separateTargets:
              chevron.right <= buttons[0].left &&
              buttons[0].right <= buttons[1].left,
          };
        }),
      )
      .toEqual({ centered: true, spacing: 28, separateTargets: true });
    await summary.screenshot({
      path: info.outputPath(`section-label-${width}.png`),
    });
  }
  await sidebar.evaluate((element) => {
    element.closest(".shell-sidebar").style.width = "520px";
  });
  await expect(title).not.toHaveAttribute("data-overflowing");
  await expect(title).toHaveCSS("mask-image", "none");
});
