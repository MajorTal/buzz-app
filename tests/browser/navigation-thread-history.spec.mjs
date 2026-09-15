import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
});

test("Back restores each thread visit before the previous channel", async ({
  page,
  app,
}) => {
  await open(page, app);
  const roots = app.histories
    .get("primary/alpha")
    .filter((row) => row.content.startsWith("Thread root"));
  const threadButton = (root) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });

  await threadButton(roots[0]).click();
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  await threadButton(roots[1]).click();
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  const openThread = await panel
    .getByRole("region", { name: "Thread messages", exact: true })
    .elementHandle();
  await threadButton(roots[1]).click();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  expect(await openThread.evaluate((node) => node.isConnected)).toBe(true);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();

  await page.goBack();
  await expect(panel.getByText("Thread root 1", { exact: true })).toBeVisible();
  const threadPanel = await panel.elementHandle();
  await page.goBack();
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  expect(
    await threadPanel.evaluate(
      (node) => node === document.querySelector('aside[aria-label="Thread"]'),
    ),
  ).toBe(true);
});

for (const reading of [false, true]) {
  test(`ordinary reply-count opening ${reading ? "preserves intervening reading" : "finishes at the bottom"} after held pagination`, async ({
    page,
    app,
  }) => {
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    let last;
    for (let i = 0; i < 120; i++) last = app.reply(root.id, false, false);
    await open(page, app);
    const region = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requested = false;
    const routePattern = "**/api/relay/**/query";
    await page.route(routePattern, async (route) => {
      if (
        !requested &&
        route
          .request()
          .postDataJSON()
          .some(
            (filter) =>
              filter.depth_limit && filter.thread_cursor !== undefined,
          )
      ) {
        requested = true;
        await held;
      }
      await route.continue();
    });
    try {
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await expect.poll(() => requested).toBe(true);
      await expect(region.locator("[data-message-id]")).toHaveCount(51);
      await expect(
        region.getByText("Loading thread…", { exact: true }),
      ).toBeVisible();
      // The panel is presented even while bounded history is still pending.
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
      let position = 0;
      if (reading) {
        await region.hover();
        await page.mouse.wheel(0, 500);
        await expect
          .poll(() => region.evaluate((node) => node.scrollTop))
          .toBe(500);
        position = await region.evaluate((node) => node.scrollTop);
      }
      release();
      await expect(region.locator("[data-message-id]")).toHaveCount(124);
      await expect(
        region.getByText("Loading thread…", { exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureNavigation.snapshot().status),
        )
        .toBe("opened");
      if (reading) {
        expect(await region.evaluate((node) => node.scrollTop)).toBe(position);
      } else {
        await expect
          .poll(() =>
            region.evaluate(
              (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
            ),
          )
          .toBeLessThan(4);
        await expect(
          region.locator(`[data-message-id="${last.id}"]`),
        ).toBeInViewport();
        await expect(
          page.getByRole("button", { name: "Close thread", exact: true }),
        ).toBeFocused();
      }
      const live = app.reply(root.id);
      await expect(
        region.locator(`[data-message-id="${live.id}"]`),
      ).toBeVisible();
      if (reading) {
        expect(await region.evaluate((node) => node.scrollTop)).toBe(position);
      } else {
        await expect(
          region.locator(`[data-message-id="${live.id}"]`),
        ).toBeInViewport();
      }
    } finally {
      release();
      await page.unroute(routePattern);
    }
  });
}
