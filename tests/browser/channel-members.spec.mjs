import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ pluginFixtures: true });

// Browser-only contract: real header composition, modal focus and responsive geometry.
// Write/search failure matrices live in the mounted component and session tests.
test("channel members opens from the header, fits each viewport, and returns keyboard focus", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const conversation = page.getByRole("article", { name: "Conversation" });
  await expect(
    conversation.getByRole("tab", { name: "Alpha", exact: true }),
  ).toBeVisible();
  const trigger = conversation.getByRole("button", {
    name: "Channel members",
    exact: true,
  });
  for (const [width, height, mode] of [
    [1440, 850, "light"],
    [800, 850, "dark"],
    [390, 850, "light"],
    [800, 300, "dark"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      (value) =>
        document.documentElement.setAttribute("data-color-mode", value),
      mode,
    );
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await expect(dialog.getByText(/Members ·/)).toBeVisible();
    await expect(dialog.getByText("Loading members…")).toHaveCount(0);
    // Finish the entrance before measuring; content changes must not recenter it.
    await dialog.evaluate(async (node) => {
      await Promise.all(
        node.getAnimations().map((animation) => animation.finished),
      );
    });
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    const search = dialog.getByRole("searchbox");
    await search.fill("no-matching-member");
    await expect(
      dialog.getByText("No members match your search."),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const next = await dialog.boundingBox();
        return { height: next.height, y: next.y };
      })
      .toEqual({ height: box.height, y: box.y });
    await search.fill("");
    await expect(dialog.getByText("No members match your search.")).toHaveCount(
      0,
    );
    await expect
      .poll(async () => (await dialog.boundingBox()).height)
      .toBe(box.height);
    const body = dialog.locator(".buzz-dialog-body");
    await expect(body).toHaveCSS("overflow-y", "hidden");
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    await expect(list).toHaveCSS("overflow-y", "auto");
    await expect(
      dialog.getByRole("button", { name: "Close channel members" }),
    ).toBeInViewport();
    // A single compact row now fits at 360px; use a genuinely constrained viewport.
    if (height === 300) {
      expect(
        await list.evaluate((node) => node.scrollHeight > node.clientHeight),
      ).toBe(true);
      await list.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect
        .poll(() => list.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(0);
      await expect(
        dialog.getByRole("button", { name: "Close channel members" }),
      ).toBeInViewport();
    }
    await page.screenshot({
      path: testInfo.outputPath(
        `channel-members-${width}-${height}-${mode}.png`,
      ),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

// Native history traversal/reload plus the real channel tab owner cannot be
// represented by a dialog-only jsdom test. No member mutations are performed.
test("Members has a reloadable history visit without replacing channel tabs or drafts", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const trigger = conversation.getByRole("button", {
    name: "Channel members",
    exact: true,
  });
  const composer = conversation.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const entry = () => page.evaluate(() => history.state.buzzNavigationV1.entry);
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  await conversation
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page
    .locator("[data-panel-workspace]")
    .getByRole("tab", { name: "Channel settings", exact: true });
  await expect(settings).toHaveAttribute("aria-selected", "true");
  const before = await entry();
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Channel members",
    exact: true,
  });
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  const members = await entry();
  expect(members.id).not.toBe(before.id);
  expect(members.target).toEqual({ ...before.target, panel: "members" });
  await dialog.getByRole("searchbox").fill("not-persisted");
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  expect((await entry()).id).toBe(before.id);
  await expect(trigger).toBeFocused();
  await expect(composer).toHaveText("Keep this draft");
  await expect(settings).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  expect((await entry()).id).toBe(members.id);
  await expect(dialog.getByRole("searchbox")).toHaveValue("");
  await page.reload();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  expect((await entry()).id).toBe(members.id);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await entry()).target).toEqual(before.target);
  // Tabs remain session-owned; reload creates a new relay session. Their disk
  // persistence is deliberately not part of the Members route.
  await expect(composer).toHaveText("Keep this draft");
  // Explicit dismissal is itself a visit, so Back can recover the list.
  await page.goBack();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  expect((await entry()).id).toBe(members.id);
  await page.goForward();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(composer).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Alpha");
  expect((await entry()).id).toBe(members.id);
});

// Members must not compete with an exact-message reveal for modal focus.
test.describe("scoped Members history", () => {
  test.use({
    exactMessages: true,
    historyCounts: { alpha: 3, beta: 0 },
  });
  test("Members keeps modal focus above an exact timeline target", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const target = {
      version: 1,
      kind: "conversation",
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
      channelId: "alpha",
      messageId: app.exact.root.id,
      panel: "members",
    };
    expect(
      await page.evaluate(
        (target) => window.fixtureNavigation.open(target),
        target,
      ),
    ).toEqual({ status: "opened" });
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await dialog
      .getByRole("button", { name: "Close channel members", exact: true })
      .click();
    await expect(
      page.locator(
        `[data-channel-timeline="alpha"] [data-message-id="${target.messageId}"]`,
      ),
    ).toBeFocused();
  });
  test("restores Members over a routed thread and respects account scope", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const target = {
      version: 1,
      kind: "conversation",
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
      channelId: "alpha",
      messageId: app.exact.target.id,
      threadRootId: app.exact.root.id,
    };
    expect(
      await page.evaluate(
        (target) => window.fixtureNavigation.open(target),
        target,
      ),
    ).toEqual({ status: "opened" });
    await page
      .getByRole("button", { name: "Channel members", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    const entry = await page.evaluate(
      () => history.state.buzzNavigationV1.entry,
    );
    expect(entry.target).toEqual({ ...target, panel: "members" });
    await page.reload();
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(
      (await page.evaluate(() => history.state.buzzNavigationV1.entry)).target,
    ).toEqual(target);
    await expect(
      page
        .getByRole("region", { name: "Thread messages", exact: true })
        .locator(`[data-message-id="${target.messageId}"]`),
    ).toBeFocused();
    await page.goBack();
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    expect(
      await page.evaluate((target) => window.fixtureNavigation.open(target), {
        ...entry.target,
        scope: { ...target.scope, viewer: "a".repeat(64) },
      }),
    ).toEqual({ status: "failed", reason: "denied" });
    await expect(dialog).toHaveCount(0);
  });
});

// Sessions have no Members surface; handwritten routes must retain the exact
// reader rather than suppressing its focus for a modal that cannot mount.
test.describe("Members on an unsupported session destination", () => {
  test.use({
    exactMessages: true,
    sessionChannels: ["alpha"],
    historyCounts: { alpha: 3, beta: 0 },
  });
  test("discards the unavailable panel while preserving message focus and history", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Messages");
    const target = {
      version: 1,
      kind: "conversation",
      channelId: "alpha",
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
      messageId: app.exact.target.id,
    };
    expect(
      await page.evaluate((target) => window.fixtureNavigation.open(target), {
        ...target,
        panel: "members",
      }),
    ).toEqual({ status: "opened" });
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    const row = page
      .getByRole("region", { name: "Selected session message", exact: true })
      .locator(`[data-message-id="${target.messageId}"]`);
    await expect(row).toBeFocused();
    await expect(dialog).toHaveCount(0);
    expect(
      (await page.evaluate(() => history.state.buzzNavigationV1.entry)).target,
    ).toEqual(target);
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    await expect(row).toBeFocused();
    await expect(dialog).toHaveCount(0);
    expect(
      (await page.evaluate(() => history.state.buzzNavigationV1.entry)).target,
    ).toEqual(target);
  });
});
