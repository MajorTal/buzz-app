import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Real shell layout and route remounts must preserve the user's resized width.
test("Settings keeps the channel sidebar width across navigation and reload", async ({
  page,
  app,
}) => {
  await open(page, app);
  const channels = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  const settings = page.getByRole("complementary", {
    name: "Settings sidebar",
    exact: true,
  });
  const handle = page.getByRole("separator", {
    name: "Resize channel sidebar",
    exact: true,
  });
  for (const [key, width] of [
    ["Home", 220],
    ["End", 520],
  ]) {
    await handle.press(key);
    await expect
      .poll(async () => (await channels.boundingBox())?.width)
      .toBe(width);
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect
      .poll(async () => (await settings.boundingBox())?.width)
      .toBe(width);
    await page.reload();
    await expect
      .poll(async () => (await settings.boundingBox())?.width)
      .toBe(width);
    await settings.getByRole("button", { name: "Back", exact: true }).click();
    await expect
      .poll(async () => (await channels.boundingBox())?.width)
      .toBe(width);
  }
});

test("narrow Settings drawer matches the clamped channel sidebar", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page
    .getByRole("separator", { name: "Resize channel sidebar" })
    .press("End");
  await page.setViewportSize({ width: 600, height: 950 });
  await expect(
    page.getByRole("complementary", { name: "Channel sidebar" }),
  ).not.toBeVisible();
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const contentWidth = (await conversation.boundingBox()).width;
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  expect((await conversation.boundingBox()).width).toBe(contentWidth);
  const channels = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  await expect
    .poll(async () => (await channels.boundingBox())?.width)
    .toBe(220);
  await channels
    .getByRole("button", { name: "Beta", exact: true })
    .press("Enter");
  await expect(channels).toBeHidden();
  const composer = page.getByRole("textbox", {
    name: "Message #Beta",
    exact: true,
  });
  await expect(composer).toBeFocused();
  await page.keyboard.type("Usable destination");
  await expect(composer).toHaveText("Usable destination");
  await composer.fill("");
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  const settings = page.getByRole("complementary", {
    name: "Settings sidebar",
    exact: true,
  });
  await expect
    .poll(async () => (await settings.boundingBox())?.width)
    .toBe(220);
  await settings
    .getByRole("button", { name: "Notifications", exact: true })
    .press("Enter");
  await expect(settings).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  await expect(
    page.getByRole("region", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  // Selecting the current section is a new attempt, not a new history visit.
  await settings
    .getByRole("button", { name: "Notifications", exact: true })
    .press("Enter");
  await expect(settings).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await expect
    .poll(async () => (await channels.boundingBox())?.width)
    .toBe(220);
  await page.setViewportSize({ width: 1440, height: 950 });
  await expect
    .poll(async () => (await channels.boundingBox())?.width)
    .toBe(520);
});

test("sidebar width survives route remounts when saving it fails", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith("buzz-view.v1:") &&
        key.includes('"channel-sidebar"')
      ) {
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  });
  await page
    .getByRole("separator", { name: "Resize channel sidebar" })
    .press("End");
  const channels = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  await expect
    .poll(async () => (await channels.boundingBox())?.width)
    .toBe(520);
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("complementary", {
    name: "Settings sidebar",
    exact: true,
  });
  await expect
    .poll(async () => (await settings.boundingBox())?.width)
    .toBe(520);
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await expect
    .poll(async () => (await channels.boundingBox())?.width)
    .toBe(520);
});
