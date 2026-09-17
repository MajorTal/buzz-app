import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, readState: true, threadUnread: true });

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
  // The accessible name also includes the unread count once catch-up finishes.
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: /^Beta(?: |$)/ })
    .click();
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
