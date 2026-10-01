import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
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

// Browser-only: top-layer painting and hit testing against a real scroll pane.
test("selected message actions hide beyond their pane and return with it", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  expect(
    await openTarget(page, target(app, app.exact.target.id, app.exact.root.id)),
  ).toEqual({ status: "opened" });
  const pane = selected(page);
  const row = pane.locator(`[data-message-id="${app.exact.target.id}"]`);
  await expect(row).toBeFocused();
  const actions = row.getByRole("group", {
    name: "Message actions",
    includeHidden: true,
  });
  const shown = (visible) =>
    expect
      .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
      .toBe(visible);
  // Fixture replies are short; stand in for a long selected message whose pane
  // scrolls well past the toolbar's anchor.
  await row.locator(":scope > [data-layout]").evaluate((node) => {
    node.style.minHeight = "1600px";
  });
  await settle(page, pane);
  await row.getByText("Exact reply edited", { exact: true }).hover();
  await shown(true);
  const focused = actions.getByRole("button").first();
  await focused.focus();
  await page.mouse.move(0, 0);
  await shown(true);
  const back = page.getByRole("button", {
    name: "Back to latest",
    exact: true,
  });
  const backBox = await back.boundingBox();
  const point = {
    x: backBox.x + backBox.width / 2,
    y: backBox.y + backBox.height / 2,
  };
  // Scroll the anchor up under the selected-message navigation.
  await actions.evaluate((bar, point) => {
    const section = bar.closest("section");
    section.scrollTop +=
      bar.parentElement.getBoundingClientRect().top -
      point.y +
      bar.offsetHeight / 2;
  }, point);
  await settle(page, pane);
  await shown(false);
  await expect(actions).toHaveCSS("opacity", "0");
  await expect(focused).toBeFocused();
  expect(
    await back.evaluate(
      (button, point) =>
        button.contains(document.elementFromPoint(point.x, point.y)),
      point,
    ),
  ).toBe(true);
  await pane.evaluate((section) => {
    section.scrollTop = 0;
  });
  await settle(page, pane);
  await shown(true);
  await expect
    .poll(() =>
      actions.evaluate((bar) => {
        const rect = bar.getBoundingClientRect();
        const slot = bar.parentElement.getBoundingClientRect();
        const pane = bar.closest("section").getBoundingClientRect();
        return Math.abs(rect.bottom - slot.top) < 1 && rect.bottom > pane.top;
      }),
    )
    .toBe(true);
});

const membershipTest = test.extend({ membershipActivity: true });
membershipTest(
  "a loaded session reply reveals in the existing timeline without an exact lookup",
  async ({ page, app }) => {
    await page.goto(app.origin);
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation?.snapshot().status),
      )
      .toBe("opened");
    expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
    await expect(history(page)).toBeVisible();
    // The Sessions page must pass the active viewer through to its shared timeline.
    await expect(history(page).locator("[data-membership-row]")).toContainText(
      "Pinky added by you, along with Brain",
    );
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
  },
);

// Real container geometry, pointer targeting and editing at enlarged interface sizes.
test("Sessions keeps new and selected conversations usable at 200%", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 800, height: 768 });
  await page.goto(app.origin);
  await openPage(page, "Sessions");
  const workspace = page.getByRole("region", { name: "Sessions", exact: true });
  const composer = workspace.getByRole("textbox", {
    name: "Message this session",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  const expectReachable = async () => {
    await expect
      .poll(() =>
        composer.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 150 &&
            r.left >= 0 &&
            r.right <= innerWidth &&
            r.top >= 0 &&
            r.bottom <= innerHeight &&
            el.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            )
          );
        }),
      )
      .toBe(true);
    await composer.click();
    await page.keyboard.type("Scaled session draft");
    await expect(composer).toHaveText("Scaled session draft");
  };
  await expectReachable();
  await workspace
    .getByRole("navigation", { name: "Previous sessions" })
    .getByRole("button", { name: /Alpha/ })
    .click();
  await expect(
    workspace.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expectReachable();
  await workspace
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await expect(composer).toHaveText("Scaled session draft");
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await expect(composer).toBeInViewport();
});

// The same session column is also hosted by Channels, outside SessionsWorkspace.
test("Channels session columns use their available width at 200%", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 800, height: 768 });
  await page.goto(app.origin);
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  expect(await openTarget(page, target(app))).toEqual({ status: "opened" });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const composer = conversation.getByRole("textbox", {
    name: "Message this session",
    exact: true,
  });
  await expect
    .poll(() =>
      composer.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const panel = el.closest("article").getBoundingClientRect();
        const column = el
          .closest('[class*="_column_"]')
          .getBoundingClientRect();
        return (
          column.width > panel.width * 0.9 &&
          r.left >= 0 &&
          r.right <= innerWidth &&
          r.bottom <= innerHeight
        );
      }),
    )
    .toBe(true);
  await composer.click();
  await page.keyboard.type("Channel session draft");
  await expect(composer).toHaveText("Channel session draft");
});
