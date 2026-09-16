import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });
const entry = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry);

test("channel visits, toolbar, browser traversal and Settings sections share one history", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = await entry(page);
  expect(alpha.target.channelId).toBe("alpha");
  await button(page, "Beta").click();
  await expect(composer(page, "Beta")).toBeVisible();
  const beta = await entry(page);
  expect(beta.id).not.toBe(alpha.id);
  await button(page, "Go back").click();
  await expect(composer(page, "Alpha")).toBeVisible();
  expect((await entry(page)).id).toBe(alpha.id);
  // Reclick is retry, not a new visit or forward-stack truncation.
  await button(page, "Alpha").click();
  expect((await entry(page)).id).toBe(alpha.id);
  await expect(button(page, "Go forward")).toBeEnabled();
  await button(page, "Go forward").click();
  await expect(composer(page, "Beta")).toBeVisible();
  expect((await entry(page)).id).toBe(beta.id);
  await page.goBack();
  await expect(composer(page, "Alpha")).toBeVisible();
  await page.goForward();
  await expect(composer(page, "Beta")).toBeVisible();
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sections
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await button(page, "Go back").click();
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await button(page, "Go back").click();
  await expect(composer(page, "Beta")).toBeVisible();
});
