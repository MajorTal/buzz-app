import { test, expect } from "./fixture.mjs";

const github = "https://github.com/block/buzz/pull/1";
const ordinary = "https://example.test/external-link";
const unsupported = "https://github.com/block/buzz/blob/main/README.md";
const button = (page, name) => page.getByRole("button", { name, exact: true });
// Presentation plugins may shorten a raw URL label; the destination remains the contract.
const link = (page, url) => page.locator(`a[href=${JSON.stringify(url)}]`);

async function openMessages(page) {
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Messages" })
    .click();
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
}

async function popup(page, anchor) {
  const opened = page.waitForEvent("popup");
  await anchor.click();
  const external = await opened;
  await external.waitForLoadState();
  expect(await external.evaluate(() => window.opener === null)).toBe(true);
  const url = external.url();
  await external.close();
  return url;
}

// Runs the built app and real plugin lifecycle. This verifies normal web fallback
// and plugin precedence; native registration/permissions have a separate guard.
test("unhandled links open externally and disabling GitHub restores the fallback", async ({
  page,
  context,
  app,
}) => {
  for (const url of [github, ordinary, unsupported])
    await context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>External destination</title>",
      }),
    );
  await page.route("https://api.github.com/repos/block/buzz/pulls/1", (route) =>
    route.fulfill({ json: { title: "A useful change", state: "open" } }),
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append("primary", "alpha", `${github} ${ordinary} ${unsupported}`);
  await link(page, github).click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "A useful change" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  expect(
    await popup(page, panel.getByRole("link", { name: "Open on GitHub" })),
  ).toBe(github);
  expect(await popup(page, link(page, ordinary))).toBe(ordinary);
  expect(await popup(page, link(page, unsupported))).toBe(unsupported);
  await expect(panel).toBeVisible();

  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
  await page.getByRole("switch", { name: "Enable GitHub" }).click();
  await openMessages(page);
  await expect(panel).toHaveCount(0);
  expect(await popup(page, link(page, github))).toBe(github);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();

  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
  await page.getByRole("switch", { name: "Enable GitHub" }).click();
  await openMessages(page);
  await link(page, github).focus();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: "A useful change" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);
});
