import { test, expect } from "./source-fixture.mjs";

test("reaction plus opens a visible emoji-only picker, restores focus and publishes custom emoji", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions");
  const plus = page.getByRole("button", {
    name: "Add reaction",
    exact: true,
  });
  // Only one fixture message has reactions; the others must have no action.
  await expect(plus).toHaveCount(1);
  await plus.click();
  const search = page.locator('em-emoji-picker input[type="search"]');
  await expect(search).toBeVisible();
  const padding = await search.evaluate((input) => {
    const field = input.getBoundingClientRect();
    const picker = input
      .getRootNode()
      .querySelector("#root")
      .getBoundingClientRect();
    return {
      top: field.top - picker.top,
      left: field.left - picker.left,
      right: picker.right - field.right,
    };
  });
  expect(padding.top).toBeCloseTo(padding.left, 1);
  expect(padding.top).toBeCloseTo(padding.right, 1);
  await expect(search).toHaveCSS("border-radius", "14px");
  await expect(page.getByRole("tab", { name: "GIF", exact: true })).toHaveCount(
    0,
  );
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(plus).toBeFocused();
  await plus.click();
  await search.fill("party");
  const custom = page
    .locator("em-emoji-picker button")
    .filter({ has: page.locator('img[src*="1.png"]') })
    .first();
  await expect(custom).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("reaction-picker.png"),
  });
  await custom.click();
  await expect(search).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(1);
  const event = await page.evaluate(
    () => window.emojiFixture.report.publications[0].event,
  );
  expect(event.kind).toBe(7);
  expect(event.content).toBe(":party:");
  expect(event.tags).toContainEqual([
    "emoji",
    "party",
    "https://a.test/media/1.png",
  ]);
  expect(event.tags.filter(([name]) => name === "e")).toHaveLength(1);
  for (const length of [62, 63, 64]) {
    await plus.click();
    const boundarySearch = page.locator('em-emoji-picker input[type="search"]');
    const shortcode = "a".repeat(length);
    await boundarySearch.fill(shortcode);
    await page
      .getByRole("button", { name: `:${shortcode}:`, exact: true })
      .click();
  }
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(4);
  await page.evaluate(() => window.emojiFixture.archive(true));
  await expect(plus).toHaveCount(0);
  await page.evaluate(() => window.emojiFixture.archive(false));
  await expect(plus).toHaveCount(1);
  const boundaryEvents = await page.evaluate(() =>
    window.emojiFixture.report.publications.slice(1).map(({ event }) => event),
  );
  expect(boundaryEvents.map(({ content }) => content)).toEqual(
    [62, 63, 64].map((length) => `:${"a".repeat(length)}:`),
  );
  expect(boundaryEvents.every(({ kind }) => kind === 7)).toBe(true);
  await page.evaluate(() => window.emojiFixture.rejectReaction());
  await plus.click();
  await page
    .locator("em-emoji-picker button")
    .filter({ has: page.locator('img[src*="1.png"]') })
    .first()
    .click();
  const retry = page.getByRole("button", { name: "Retry reaction" });
  await expect(retry).toBeVisible();
  await page.evaluate(() => window.emojiFixture.remount());
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(5);
  expect(errors).toEqual([]);
});
