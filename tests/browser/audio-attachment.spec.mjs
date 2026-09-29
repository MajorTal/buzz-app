import { test, expect } from "./source-fixture.mjs";

// Browser-only: this verifies the real CSS cascade and computed token colors;
// jsdom cannot compute the authored stylesheet or media-error presentation.
test("audio attachment errors keep the warning treatment in light and dark", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/audio-attachment.html");
  await page
    .getByRole("button", { name: "Trigger audio error", exact: true })
    .click();
  const status = page.getByRole("status");
  await expect(status).toHaveText("Audio unavailable");

  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((element, theme) => {
      element.dataset.colorMode = theme;
    }, theme);
    const colors = await status.evaluate((element) => {
      const style = getComputedStyle(element);
      const rootStyle = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.style.display = "none";
      document.body.append(probe);
      const readToken = (name) => {
        probe.style.color = rootStyle.getPropertyValue(name).trim();
        return getComputedStyle(probe).color;
      };
      const result = {
        background: style.backgroundColor,
        border: style.borderTopColor,
        color: style.color,
        expectedBackground: readToken("--affordance-warning"),
        expectedBorder: readToken("--border-warning"),
        expectedColor: readToken("--text-warning"),
      };
      probe.remove();
      return result;
    });
    expect(colors.background).toBe(colors.expectedBackground);
    expect(colors.border).toBe(colors.expectedBorder);
    expect(colors.color).toBe(colors.expectedColor);
    const screenshotPath = testInfo.outputPath(
      `audio-unavailable-${theme}.png`,
    );
    await status.screenshot({ path: screenshotPath, scale: "css" });
    await testInfo.attach(`audio-unavailable-${theme}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  }
});
