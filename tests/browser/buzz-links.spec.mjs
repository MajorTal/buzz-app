import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
});
const button = (page, name) => page.getByRole("button", { name, exact: true });
const state = (page) =>
  page.evaluate(() => window.fixtureNavigation.snapshot());

test("Buzz channel and message links render, reveal verified targets, and preserve navigation history", async ({
  page,
  app,
}) => {
  app.relay.holdProfiles([app.viewer]);
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Broadcast reply");
  const href = `buzz://message?channel=alpha&id=${target.id}`;
  const message = app.append(
    "primary",
    "alpha",
    `Open <${href}> or <buzz://channel/beta>.`,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  await expect(
    row.getByRole("link", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("link", { name: "#Beta", exact: true }),
  ).toBeVisible();
  await expect(row).not.toContainText("<buzz:");
  const link = row.getByRole("link", { name: "Alpha", exact: true });
  await expect(link).toHaveCSS("text-decoration-line", "none");
  await expect(link).toHaveCSS("color", "rgb(17, 50, 100)");
  await link.hover();
  const preview = page.getByLabel("Message preview", { exact: true });
  await expect(
    preview.getByText("Broadcast reply", { exact: true }),
  ).toBeVisible();
  await expect(preview).toHaveClass(/buzz-preview-card/);
  await expect(preview.getByRole("img")).toHaveClass(/buzz-avatar/);
  await expect(preview).toHaveCSS("font-size", "16px");
  await expect(preview.locator("strong")).not.toBeEmpty();
  await expect(preview.locator("time")).toHaveAttribute(
    "datetime",
    new Date(target.created_at * 1000).toISOString(),
  );
  await expect(preview).toHaveRole("link");
  await expect(preview).toHaveAttribute("href", href);
  // Crossing the trigger-to-card gap must keep the destination clickable.
  await preview.hover();
  await expect(preview).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("buzz-link-preview.png"),
  });
  await preview.click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.messageId).toBe(target.id);
  await expect(panel.getByText("Thread root 0", { exact: true })).toBeVisible();
  await button(page, "Close thread").click();
  await expect(panel).toHaveCount(0);
  await button(page, "Go back").click();
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await button(page, "Go back").click();
  await expect(panel).toHaveCount(0);
  await page.mouse.move(1400, 10);
  await row.getByRole("link", { name: "#Beta", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  // WebKit follows macOS's tab-to-links preference; retain keyboard modality
  // while focusing the specific trigger under test.
  await link.focus();
  await expect(link).toBeFocused();
  expect(
    await link.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  const focusedTrigger = await link.elementHandle();
  app.relay.releaseProfiles();
  await expect(
    row.getByRole("button", {
      name: "View Fixture Reader profile",
      exact: true,
    }),
  ).toBeVisible();
  expect(await focusedTrigger.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect(link).toBeFocused();
  await expect(preview).toBeVisible();
  expect(
    app.report.brokerRequests.some(({ url }) => url.endsWith("/agent-library")),
  ).toBe(false);
  await link.press("Tab");
  await expect(preview).toBeFocused();
  await preview.press("Enter");
  await expect(
    panel.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await button(page, "Close thread").click();
  await expect(link).toBeFocused();
  await row.getByRole("link", { name: "#Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
});

test("activating a panel from a linked thread retires the navigation-owned thread instead of splitting the rail", async ({
  page,
  app,
}) => {
  await open(page, app);
  const history = app.histories.get("primary/alpha");
  const target = history.find((row) => row.content === "Broadcast reply");
  const href = `buzz://message?channel=alpha&id=${target.id}`;
  const message = app.append("primary", "alpha", `Open <${href}>.`);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const link = row.getByRole("link", { name: "Alpha", exact: true });
  await expect(link).toBeVisible();
  await link.click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${target.id}"]`),
  ).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  // Open a panel while the linked thread is showing. Navigation still owns the
  // thread target, so it must be retired rather than share the rail slot with
  // the newly activated panel. (The fixture registers a catch-all panel.)
  await row
    .getByRole("button", { name: "View Fixture Reader profile", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Wrong panel", exact: true }),
  ).toBeVisible();
  await expect(thread).toHaveCount(0);
  // Exactly the sidebar plus one panel: the thread does not survive alongside it.
  await expect(page.getByRole("complementary")).toHaveCount(2);
});

test("a mixed-case Buzz scheme activates in-app instead of falling through to an external tab", async ({
  page,
  app,
}) => {
  await open(page, app);
  // parseBuzzLink normalizes the scheme via URL, so a BUZZ:// link is a valid
  // internal destination; activation must classify it the same way rather than
  // treating it as an external _blank link.
  const message = app.append(
    "primary",
    "alpha",
    "Jump to <BUZZ://channel/beta>.",
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  const link = row.getByRole("link", { name: "#Beta", exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
});

test("unavailable messages fail honestly and legacy links still open when Links is disabled", async ({
  page,
  app,
}) => {
  await open(page, app);
  const target = app.histories
    .get("primary/alpha")
    .find((row) => row.content === "Thread root 0");
  const href = `buzz://message?channel=alpha&id=${target.id}&thread=${"f".repeat(64)}`;
  const message = app.append(
    "primary",
    "alpha",
    `<${href}> <buzz://message?channel=alpha&id=${"0".repeat(64)}>`,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${message.id}"]`,
  );
  await expect(
    row.getByRole("link", { name: "Alpha", exact: true }).first(),
  ).toBeVisible();
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
  await page
    .getByRole("switch", { name: "Enable Links", exact: true })
    .uncheck();
  await button(page, "Messages").first().click();
  await row.locator("a").first().click();
  const targetRow = page.locator(`[data-message-id="${target.id}"]`);
  await expect(targetRow).toBeFocused();
  await expect(targetRow).toBeInViewport();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  // The deliberately wrong hint must not select a different root or force a
  // visible root out of the ordinary timeline.
  await row.locator("a").nth(1).click();
  await expect(button(page, "Retry navigation")).toBeVisible();
  expect((await state(page)).status).toBe("failed");
});
