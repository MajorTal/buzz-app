import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 20 },
});

test("Back restores each thread visit before the previous channel", async ({
  page,
  app,
}) => {
  const beta = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator('button[data-channel-id="beta"]');
  app.relay.holdUnread();
  try {
    await open(page, app);
    await expect.poll(() => app.report.unreadHolds.length).toBe(1);
    await expect(beta).toHaveAccessibleName("Beta");
  } finally {
    app.relay.releaseUnread();
  }
  // Unread evidence changes the accessible name independently of navigation.
  await expect(beta.getByRole("img")).toHaveAccessibleName(
    "20 observed unread messages. Not an exact total.",
  );
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
  await beta.click();
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
