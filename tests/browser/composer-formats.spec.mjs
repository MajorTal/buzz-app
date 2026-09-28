import { test, expect } from "./source-fixture.mjs";

// Browser contracts: native caret/keystrokes, toolbar focus, DOM deletion and
// hidden spoiler paint/hit testing. Format/serialization matrices stay in Vitest.
async function composer(page) {
  await page.goto("/tests/fixtures/link-messages.html");
  const input = page.getByRole("textbox", {
    name: "Message #design",
    exact: true,
  });
  await input.fill("");
  await page
    .getByRole("button", { name: "Toggle formatting", exact: true })
    .click();
  return input;
}

test("native code corrections preserve explicit mode but clearing the span exits it", async ({
  page,
}) => {
  const input = await composer(page);
  const toggle = page.getByRole("button", {
    name: "Toggle formatting",
    exact: true,
  });
  const close = page.getByRole("button", {
    name: "Close formatting",
    exact: true,
  });
  await expect(toggle).toHaveCount(0);
  // Real rendered sizes must match the close control, not compact attachment actions.
  for (const button of [
    close,
    page.getByRole("button", { name: "Bold", exact: true }),
  ]) {
    await expect(button).toHaveCSS("width", "32px");
    await expect(button).toHaveCSS("height", "32px");
    await expect(button.locator("svg")).toHaveCSS("width", "16px");
  }
  await close.press("Enter");
  await expect(toggle).toBeFocused();
  await toggle.press("Enter");
  await expect(close).toBeFocused();
  await expect(toggle).toHaveCount(0);

  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.keyboard.type("abc");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("d");
  await expect(input.locator("code")).toHaveText("abd");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input.locator("code")).toHaveText("abd");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(input.locator("code")).toHaveText("ab");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("plain");
  await expect(input.locator("code")).toHaveCount(0);
  await input.press("Enter");
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.at(-1).text),
  ).toBe("plain");
});

test("list toolbar, native item splitting and indentation survive reload and send", async ({
  page,
}) => {
  const input = await composer(page);
  await input.fill("one\ntwo");
  await input.evaluate((el) => el.setSelectionRange(0, 7));
  await page.getByRole("button", { name: "Bullet list", exact: true }).click();
  await input.evaluate((el) => el.setSelectionRange(7, 7));
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("three");
  await page.keyboard.press("Tab");
  await expect(input.locator("ul ul > li")).toHaveText("three");
  await page.getByRole("button", { name: "Ordered list", exact: true }).click();
  await expect(input.locator("ul ol > li")).toHaveText("three");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("outside");
  await expect(input.locator(":scope > p")).toHaveText("outside");
  await page.reload();
  await expect(input.locator("ul > li")).toHaveCount(3);
  await input.press("Enter");
  expect(
    await page.evaluate(() => window.linkComposerFixture.sent.at(-1).text),
  ).toBe("- one\n- two\n- three\n\noutside");
});

test("sent spoilers hide content and links behind a keyboard-accessible reduced-motion sparkle", async ({
  page,
}) => {
  const input = await composer(page);
  await input.fill("secret https://example.com/path");
  // Collapsed selection means the entire draft, including the URL, becomes a spoiler.
  await page.getByRole("button", { name: "Spoiler", exact: true }).click();
  await input.press("Enter");
  const preview = page.getByRole("region", { name: "Sent message preview" });
  const reveal = preview.getByRole("button", {
    name: "Reveal spoiler",
    exact: true,
  });
  await expect(reveal).toBeVisible();
  await expect(preview.locator("[inert]")).not.toBeVisible();
  await expect(preview.getByRole("link")).toHaveCount(0);
  expect(
    await reveal.evaluate(
      (el) => getComputedStyle(el, "::before").animationName,
    ),
  ).toMatch(/spoiler-twinkle/);
  const transform = () =>
    reveal.evaluate((el) => getComputedStyle(el, "::before").transform);
  const initialTransform = await transform();
  expect(initialTransform).not.toBe("none");
  await expect.poll(transform).not.toBe(initialTransform);
  await reveal.focus();
  await page.keyboard.press("Space");
  await expect(preview.getByRole("link")).toBeVisible();
  await expect(preview.getByText("secret", { exact: false })).toBeVisible();
  await preview
    .getByRole("button", { name: "Hide spoiler", exact: true })
    .click({ position: { x: 3, y: 3 } });
  await expect(preview.getByRole("link")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await reveal.evaluate(
      (el) => getComputedStyle(el, "::before").animationName,
    ),
  ).toBe("none");
  expect(await transform()).toBe("none");
});

// Browser-only: flex sizing and native horizontal overflow are not modeled by jsdom.
test("formatting keeps composer and send control geometry stable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 863, height: 863 });
  await page.goto("/tests/fixtures/product-ui.html");
  const playground = page.getByRole("region", { name: "Composer playground" });
  const toggle = playground.getByRole("button", {
    name: "Toggle formatting",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  const form = playground.getByRole("form");
  const send = form.getByRole("button", { name: "Send message", exact: true });
  // The catalogue page itself scrolls when editor focus returns. Compare document
  // coordinates so this assertion measures layout, not that native focus scroll.
  const box = (locator) =>
    locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      };
    });
  const before = await box(form);
  const sendBefore = await box(send);
  await toggle.click();
  const close = playground.getByRole("button", {
    name: "Close formatting",
    exact: true,
  });
  await expect(close).toBeVisible();
  await expect.poll(() => box(form)).toEqual(before);
  await expect.poll(() => box(send)).toEqual(sendBefore);
  await close.click();
  await expect(toggle).toBeVisible();
  await expect.poll(() => box(form)).toEqual(before);
  await expect.poll(() => box(send)).toEqual(sendBefore);
});
