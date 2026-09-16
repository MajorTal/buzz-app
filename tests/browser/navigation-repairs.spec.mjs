import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 1 } });
// Regressions independently reproduced by Pinky against the first wiring handoff.
const button = (page, name) => page.getByRole("button", { name, exact: true });
const entry = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry);

test("Back restores Personal space without inheriting the active community", async ({
  page,
  app,
}) => {
  await open(page, app);
  const switcher = button(page, "Switch community");
  await switcher.click();
  await button(page, "Personal space").click();
  await expect(switcher).toHaveAttribute("title", "Personal space");
  const personal = await entry(page);
  await switcher.click();
  await button(page, "Switch to Primary").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await button(page, "Go back").click();
  await expect(switcher).toHaveAttribute("title", "Personal space", {
    timeout: 1500,
  });
  expect(await entry(page)).toEqual(personal);
  await expect(
    page.getByRole("heading", { name: "Your channels, one conversation." }),
  ).toBeVisible();
  await button(page, "Go forward").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("Retry navigation reconnects the failed target session", async ({
  page,
  app,
}) => {
  let requests = 0;
  await page.route("**/api/relay/primary/session", async (route) => {
    requests++;
    if (requests === 1) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto(app.origin);
  await button(page, "Messages").first().click();
  await expect(
    page.getByRole("heading", { name: "This destination couldn’t open" }),
  ).toBeVisible();
  await button(page, "Retry navigation").click();
  await expect.poll(() => requests, { timeout: 1500 }).toBe(2);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("Skip to content focuses main without adding a visit or dropping Back", async ({
  page,
  app,
}) => {
  await open(page, app);
  await button(page, "Projects").first().click();
  const before = await entry(page);
  const url = page.url();
  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  await skip.focus();
  await skip.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 1500 });
  await expect(page.getByRole("main")).toBeFocused();
  expect(await entry(page)).toEqual(before);
  expect(page.url()).toBe(url);
  await expect(button(page, "Go back")).toBeEnabled();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("An edited navigation hash opens its destination and survives reload and Back", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = await entry(page);
  await page.evaluate(() => {
    location.hash =
      "#buzz=" +
      encodeURIComponent(
        JSON.stringify({ version: 1, kind: "settings", section: "appearance" }),
      );
  });
  const appearance = page.getByRole("heading", {
    name: "Appearance",
    exact: true,
  });
  await expect(appearance).toBeVisible({ timeout: 1500 });
  const settings = await entry(page);
  await page.reload();
  await expect(appearance).toBeVisible();
  expect(await entry(page)).toEqual(settings);
  await button(page, "Go back").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(await entry(page)).toEqual(alpha);
  await button(page, "Go forward").click();
  await expect(appearance).toBeVisible();
});

test("malformed navigation addresses fail explicitly on cold and warm entry", async ({
  page,
  app,
}) => {
  await page.goto(`${app.origin}/#buzz=%7B`);
  const failed = page.getByRole("heading", {
    name: "This destination couldn’t open",
    exact: true,
  });
  await expect(failed).toBeVisible({ timeout: 1500 });
  await button(page, "Home").first().click();
  await expect(failed).toBeHidden();
  await button(page, "Projects").first().click();
  await page.evaluate(() => {
    location.hash = "#buzz=%7B";
  });
  await expect(failed).toBeVisible({ timeout: 1500 });
  await page.reload();
  await expect(failed).toBeVisible();
  await button(page, "Go back").click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await button(page, "Go forward").click();
  await expect(failed).toBeVisible();
});
