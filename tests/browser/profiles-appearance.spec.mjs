import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

for (const mode of ["light", "dark"]) {
  test(`Profiles uses shared styles and host keyboard focus in ${mode} mode`, async ({
    page,
    app,
    browserName,
  }, info) => {
    await page.addInitScript((mode) => {
      localStorage.setItem("buzz-appearance.v1", mode);
    }, mode);
    await open(page, app);
    // Virtua mounts overscan outside the viewport. Pin a visible row instead
    // of letting an arbitrary first avatar trigger automation-driven scrolling.
    const history = page.getByRole("region", {
      name: "Channel message history",
    });
    const messageId = await history.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const avatar = Array.from(
        element.querySelectorAll(
          'button[aria-label="View Fixture Reader profile"]',
        ),
      ).find((button) => {
        const rect = button.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      });
      if (!avatar) throw new Error("No fully visible profile avatar");
      return avatar.closest("[data-message-id]").dataset.messageId;
    });
    const avatar = history
      .locator(`[data-message-id="${messageId}"]`)
      .getByRole("button", {
        name: "View Fixture Reader profile",
        exact: true,
      });
    await expect(avatar).toBeInViewport({ ratio: 1 });
    await avatar.click();
    const panel = page.getByRole("complementary", {
      name: "Profile",
      exact: true,
    });
    const region = panel.getByRole("region", { name: "Profile details" });
    const copy = panel.getByRole("button", { name: "Copy npub", exact: true });
    const key = panel.locator("code");
    await expect(region).toHaveAttribute("data-buzz-ui", "");
    await expect(region).toHaveCSS(
      "background-color",
      mode === "light" ? "rgb(255, 255, 255)" : "rgb(26, 26, 26)",
    );
    await expect(region).toHaveCSS(
      "color",
      mode === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
    );
    await expect(region).toHaveCSS("font-size", "16px");
    await expect(
      panel.getByRole("heading", { name: "Fixture Reader", exact: true }),
    ).toHaveCSS("font-size", "24px");
    await expect(key).toHaveCSS("font-size", "12px");
    await expect(key).toHaveCSS("font-family", /JetBrains Mono/);
    await expect(copy).toHaveCSS("height", "32px");
    const pill = await copy.evaluate((el) => ({
      radius: parseFloat(getComputedStyle(el).borderRadius),
      height: el.getBoundingClientRect().height,
    }));
    expect(pill.radius).toBeGreaterThanOrEqual(pill.height / 2);
    await copy.hover();
    await expect(copy).toHaveCSS(
      "background-color",
      mode === "light" ? "rgb(232, 232, 232)" : "rgb(64, 64, 64)",
    );
    await page.keyboard.press(
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab",
    );
    await copy.focus();
    await expect(copy).toHaveCSS("outline-width", "2px");
    await page.mouse.click(2, 2);
    await copy.focus();
    await expect(copy).toHaveCSS("outline-style", "none");
    // The host preference scales type once, not control geometry.
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+=`);
    await expect(region).toHaveCSS("font-size", "17.6px");
    await expect(key).toHaveCSS("font-size", "13.2px");
    await expect(copy).toHaveCSS("height", "32px");
    await page.keyboard.press(`${modifier}+0`);
    for (const width of [1280, 900, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(key).toBeVisible();
      expect(
        await region.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(false);
      expect(await key.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        false,
      );
      await panel.screenshot({
        path: info.outputPath(`profile-${mode}-${width}.png`),
      });
    }
  });
}
