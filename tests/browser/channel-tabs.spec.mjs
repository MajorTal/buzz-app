import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  dmLabels: true,
  readState: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Two real virtualized conversations, native focus, independent composers and
// signed destination routing need the app wiring and browser layout boundary.
test("channel tab sets restore conversations and keep replies and sends scoped", async ({
  page,
  app,
}) => {
  await open(page, app);
  const main = page.getByRole("article", { name: "Conversation", exact: true });
  const workspace = page.locator("[data-panel-workspace]");
  const split = main.getByRole("button", {
    name: "Toggle tab pane",
    exact: true,
  });
  const fullWidth = (await main.boundingBox()).width;
  await split.click();
  await expect(
    workspace.getByRole("tab", { name: "New tab", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    workspace.getByRole("searchbox", { name: "Find a channel or person" }),
  ).toBeFocused();
  await workspace
    .getByRole("searchbox", { name: "Find a channel or person" })
    .fill("Beta");
  await expect(split).toHaveAttribute("aria-expanded", "true");
  await split.click();
  await expect(workspace).toBeHidden();
  await expect(split).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(async () => (await main.boundingBox()).width)
    .toBeCloseTo(fullWidth, 0);
  await split.click();
  await expect(
    workspace
      .getByRole("tablist", { name: "Panel tabs", exact: true })
      .getByRole("tab"),
  ).toHaveCount(1);
  await expect(
    workspace.getByRole("searchbox", { name: "Find a channel or person" }),
  ).toHaveValue("Beta");
  await expect(
    workspace.getByRole("tab", { name: "New tab", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  // An independent account companion must not hold the channel-pane toggle open.
  await split.click();
  await expect(workspace).toBeHidden();
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "View your profile" }).click();
  const account = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await expect(account).toBeVisible();
  await expect(workspace).toBeHidden();
  await expect(split).toHaveAttribute("aria-expanded", "false");
  await split.click();
  await expect(split).toHaveAttribute("aria-expanded", "true");
  await expect(
    workspace.getByRole("tab", { name: "New tab", exact: true }),
  ).toBeVisible();
  await expect(account).toBeVisible();
  await account
    .getByRole("button", { name: "Close Profile panel", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Close New tab tab", exact: true })
    .click();
  await expect(workspace).toHaveCount(0);
  await expect(split).toBeFocused();
  await main
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .fill("Alpha draft");
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await page.locator('button[data-channel-id="beta"]').click();
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(
    workspace.getByRole("tab", { name: "Channel settings", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    main.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  const add = async (name) => {
    await workspace
      .getByRole("button", { name: "Add tab", exact: true })
      .click();
    const picker = workspace.getByRole("region", { name: "Choose a tab" });
    const search = picker.getByRole("searchbox", {
      name: "Find a channel or person",
    });
    await expect(search).toBeFocused();
    if (name === "Alice Fixture")
      await picker.getByRole("tab", { name: "DMs", exact: true }).click();
    await search.fill(name);
    await picker.getByRole("button", { name, exact: true }).click();
    await expect(
      workspace.getByRole("tab", { name, exact: true }),
    ).toBeFocused();
  };
  await add("Beta");
  const beta = workspace.getByRole("region", {
    name: "Conversation in Beta",
    exact: true,
  });
  const betaComposer = beta.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(beta.locator("[data-message-id]").first()).toBeVisible();
  await betaComposer.fill("Beta draft");
  await openPage(page, "Settings");
  await expect(workspace).toHaveCount(0);
  await openPage(page, "Messages");
  await expect(
    workspace.getByRole("tab", { name: "Beta", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(betaComposer).toHaveText("Beta draft");
  // The page palette explicitly hands focus to the main region.
  await expect(page.locator("#main-content")).toBeFocused();
  await split.click();
  await expect(workspace).toBeHidden();
  await openPage(page, "Settings");
  await openPage(page, "Messages");
  await expect(split).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(async () => (await main.boundingBox()).width)
    .toBeCloseTo(fullWidth, 0);
  await expect(workspace).toBeHidden();
  await split.click();
  await expect(
    workspace
      .getByRole("tablist", { name: "Panel tabs", exact: true })
      .getByRole("tab"),
  ).toHaveCount(2);
  await expect(
    workspace.getByRole("tab", { name: "Beta", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(betaComposer).toHaveText("Beta draft");
  await add("Alice Fixture");
  const dm = workspace.getByRole("region", {
    name: "Conversation in Alice Fixture",
    exact: true,
  });
  const dmComposer = dm.getByRole("textbox", { name: /Message/ });
  await dmComposer.fill("DM from a tab");
  await dmComposer.press("Enter");
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) =>
          event.kind === 9 &&
          event.content === "DM from a tab" &&
          event.tags.some(([key, value]) => key === "h" && value === "dm-peer"),
      ),
    )
    .toBe(true);
  await workspace.getByRole("tab", { name: "Beta", exact: true }).click();
  await expect(betaComposer).toHaveText("Beta draft");
  await add("Beta");
  await expect(
    workspace.getByRole("tab", { name: "Beta", exact: true }),
  ).toHaveCount(1);
  await expect(
    workspace.getByRole("tab", { name: "New tab", exact: true }),
  ).toHaveCount(0);
  await betaComposer.press("Enter");
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) =>
          event.kind === 9 &&
          event.content === "Beta draft" &&
          event.tags.some(([key, value]) => key === "h" && value === "beta"),
      ),
    )
    .toBe(true);
  const sent = beta.getByText("Beta draft", { exact: true });
  await expect(sent).toBeVisible();
  const row = beta
    .locator("[data-message-id]")
    .filter({ has: page.getByText("Beta draft", { exact: true }) });
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const reply = workspace.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(reply).toBeFocused();
  const threadBounds = await workspace
    .getByRole("complementary", { name: "Thread", exact: true })
    .boundingBox();
  const paneBounds = await workspace.boundingBox();
  expect(threadBounds.height).toBeCloseTo(paneBounds.height - 40, 0);
  await reply.fill("Beta reply draft");
  await workspace.getByRole("tab", { name: "Beta", exact: true }).click();
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("Beta reply draft");
  await page.locator('button[data-channel-id="beta"]').click();
  await expect(
    main.getByRole("tab", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(workspace).toHaveCount(0);
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(
    workspace.getByRole("tab", { name: "Thread · Beta", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(reply).toHaveText("Beta reply draft");
  await expect(
    main.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  await expect(
    main.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toHaveText("Alpha draft");
  // A fresh Reply after restoration must still focus the retained draft.
  await workspace.getByRole("tab", { name: "Beta", exact: true }).click();
  await row.hover();
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("Beta reply draft");
  await workspace
    .getByRole("button", { name: "Close Thread · Beta tab", exact: true })
    .click();
  await workspace.getByRole("tab", { name: "Beta", exact: true }).click();
  await expect(betaComposer).toBeVisible();
  // The narrow pane overlays the main conversation and must paint its own surface.
  await page.setViewportSize({ width: 800, height: 950 });
  await expect(workspace).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(betaComposer).toBeInViewport();
  await page.setViewportSize({ width: 1440, height: 950 });
  app.omitChannel("beta");
  await workspace
    .getByRole("tab", { name: "Channel settings", exact: true })
    .click();
  await workspace.getByText("Diagnostics", { exact: true }).click();
  await workspace
    .getByRole("button", { name: "Refresh channels", exact: true })
    .click();
  const unavailable = workspace.getByRole("tab", {
    name: "Unavailable conversation",
    exact: true,
  });
  await expect(unavailable).toBeVisible();
  await unavailable.click();
  await expect(workspace.getByRole("status")).toHaveText(
    "This conversation is no longer available.",
  );
  await expect(betaComposer).toHaveCount(0);
  await workspace
    .getByRole("button", {
      name: "Close Unavailable conversation tab",
      exact: true,
    })
    .click();
  await workspace
    .getByRole("button", { name: "Close Alice Fixture tab", exact: true })
    .click();
  await workspace
    .getByRole("button", { name: "Close Channel settings tab", exact: true })
    .click();
  await expect(workspace).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Channel settings", exact: true }),
  ).toBeFocused();
});

// Scrollbar geometry and scrollIntoView's effect on the fixed action need a browser.
test("crowded tab strip scrolls only horizontally with Add tab fixed and a thin scrollbar", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await page
    .getByRole("button", { name: "Toggle tab pane", exact: true })
    .click();
  const workspace = page.locator("[data-panel-workspace]");
  const add = workspace.getByRole("button", { name: "Add tab", exact: true });
  const list = workspace.getByRole("tablist", { name: "Panel tabs" });
  const header = workspace.locator(":scope > header");
  await expect(workspace.getByRole("searchbox")).toBeFocused();
  await page.locator("[data-panel-dock]").evaluate(async (el) => {
    await Promise.allSettled(
      el.getAnimations().map((animation) => animation.finished),
    );
  });
  const initial = await add.boundingBox();
  const height = (await header.boundingBox()).height;
  const tabBounds = await list.getByRole("tab").first().boundingBox();
  const expectTabPosition = async () => {
    const bounds = await list.getByRole("tab").last().boundingBox();
    expect(bounds.y).toBeCloseTo(tabBounds.y, 1);
    expect(bounds.height).toBeCloseTo(tabBounds.height, 1);
  };
  for (let i = 0; i < 5; i++) {
    await add.click();
    await expect(list.getByRole("tab")).toHaveCount(i + 2);
    await expect(workspace.getByRole("searchbox")).toBeFocused();
  }
  const tabs = list.getByRole("tab");
  const closeButtons = workspace.getByRole("button", {
    name: "Close New tab tab",
    exact: true,
  });
  const activeClose = closeButtons.last();
  const inactiveClose = closeButtons.nth(4);
  const thumbColor = () =>
    list.evaluate(
      (el) => getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundColor,
    );
  await add.hover();
  await expect(activeClose).toHaveCSS("opacity", "1");
  await expect(inactiveClose).toHaveCSS("opacity", "0");
  await tabs.nth(4).hover();
  await expect(inactiveClose).toHaveCSS("opacity", "1");
  await expect(activeClose).toHaveCSS("opacity", "1");
  await add.hover();
  await expect(inactiveClose).toHaveCSS("opacity", "0");
  await expectTabPosition();
  await expect.poll(thumbColor).toBe("rgba(0, 0, 0, 0)");
  await list.hover();
  await expectTabPosition();
  await expect.poll(thumbColor).not.toBe("rgba(0, 0, 0, 0)");
  const geometry = await list.evaluate((el) => ({
    overflow: el.scrollWidth > el.clientWidth,
    scrollbar: el.offsetHeight - el.clientHeight,
    nativeWidth: getComputedStyle(el).scrollbarWidth,
    trackHeight: getComputedStyle(el, "::-webkit-scrollbar").height,
  }));
  expect(geometry.overflow).toBe(true);
  await expect(list).toHaveCSS("overflow-y", "hidden");
  expect(geometry.scrollbar).toBeLessThanOrEqual(4);
  expect(geometry.nativeWidth).toBe("auto");
  expect(geometry.trackHeight).toBe("4px");
  expect((await add.boundingBox()).x).toBeCloseTo(initial.x, 1);
  expect((await header.boundingBox()).height).toBeCloseTo(height, 1);
  await list.getByRole("tab").last().press("Home");
  await expect(list.getByRole("tab").first()).toBeFocused();
  await expect(closeButtons.first()).toHaveCSS("opacity", "1");
  await expect(list).toHaveJSProperty("scrollTop", 0);
  await expectTabPosition();
  expect((await add.boundingBox()).x).toBeCloseTo(initial.x, 1);
  await list.getByRole("tab").first().press("End");
  await expect(list.getByRole("tab").last()).toBeFocused();
  await expect(list).toHaveJSProperty("scrollTop", 0);
  await expectTabPosition();
  expect((await add.boundingBox()).x).toBeCloseTo(initial.x, 1);
  // Hover leaving hides the thumb even when keyboard focus stays in the tabs.
  await add.hover();
  await expect.poll(thumbColor).toBe("rgba(0, 0, 0, 0)");
  expect((await header.boundingBox()).height).toBeCloseTo(height, 1);
  await list.hover();
  await expectTabPosition();
  await expect.poll(thumbColor).not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({ path: testInfo.outputPath("crowded-tabs.png") });
});
