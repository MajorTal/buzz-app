import { test, expect } from "./fixture.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });

test("avatar Settings access dismisses cleanly and exposes Profile and Plugins", async ({
  page,
  app,
  browserName,
}, testInfo) => {
  // macOS WebKit follows the system's text-fields-only Tab preference. Option+Tab
  // includes native buttons; exercise real key traversal, not programmatic focus.
  const tab = (backwards = false) =>
    page.keyboard.press(
      `${browserName === "webkit" && process.platform === "darwin" ? "Alt+" : ""}${backwards ? "Shift+" : ""}Tab`,
    );
  await page.goto(app.origin);
  const avatar = button(page, "Your profile");
  const account = page.getByRole("navigation", { name: "Your account" });
  const settings = account.getByRole("button", {
    name: "Settings",
    exact: true,
  });
  await expect(avatar).toHaveAttribute("aria-expanded", "false");
  await expect(button(page, "Settings")).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await avatar.click();
    await expect(account).toBeInViewport();
    await expect(avatar).toHaveAttribute("aria-expanded", "true");
    await tab();
    await expect(settings).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(account).toBeHidden();
    await expect(avatar).toBeFocused();
    await avatar.click();
    await avatar.click();
    await expect(account).toBeHidden();
    await avatar.click();
    await page.getByRole("main").click({ position: { x: 5, y: 5 } });
    await expect(account).toBeHidden();
    await avatar.click();
    await tab(true);
    await expect(button(page, "Find a page")).toBeFocused();
    await expect(account).toBeHidden();
    // Also leave from a keyboard-established starting point, not only a click.
    await tab();
    await expect(avatar).toBeFocused();
    await page.keyboard.press("Enter");
    await tab();
    await expect(settings).toBeFocused();
    await tab(true);
    await expect(avatar).toBeFocused();
    await expect(account).toBeVisible();
    await tab(true);
    await expect(button(page, "Find a page")).toBeFocused();
    await expect(account).toBeHidden();
  }
  await avatar.focus();
  await page.keyboard.press("Enter");
  await tab();
  await page.keyboard.press("Enter");
  await expect(account).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  const profile = sections.getByRole("button", {
    name: "Profile",
    exact: true,
  });
  const plugins = sections.getByRole("button", {
    name: "Plugins",
    exact: true,
  });
  const profileContent = page.getByRole("region", {
    name: "Profile",
    exact: true,
  });
  const pluginContent = page.getByRole("region", {
    name: "Plugins",
    exact: true,
  });
  await expect(profile).toHaveAttribute("aria-current", "page");
  await expect(profileContent).toBeVisible();
  await expect(pluginContent).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await profile.focus();
    await tab();
    await expect(plugins).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(plugins).toHaveAttribute("aria-current", "page");
    await expect(profile).not.toHaveAttribute("aria-current");
    await expect(plugins).toBeFocused();
    await expect(profileContent).toHaveCount(0);
    await expect(pluginContent).toBeVisible();
    await expect(
      page.getByRole("switch", { name: "Enable Channels" }),
    ).toBeVisible();
    const navigation = await sections.boundingBox();
    const content = await pluginContent.boundingBox();
    expect(navigation).not.toBeNull();
    expect(content).not.toBeNull();
    if (width === 1280) {
      expect(navigation.x + navigation.width).toBeLessThan(content.x);
      expect(Math.abs(navigation.y - content.y)).toBeLessThan(2);
    } else {
      expect(navigation.y + navigation.height).toBeLessThan(content.y);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    }
    await page.screenshot({
      path: testInfo.outputPath(`settings-${width}.png`),
    });
    await tab(true);
    await expect(profile).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(profile).toHaveAttribute("aria-current", "page");
    await expect(profileContent).toBeVisible();
    await expect(pluginContent).toHaveCount(0);
    await tab();
    await tab();
    await expect(
      sections.getByRole("button", { name: "Appearance", exact: true }),
    ).toBeFocused();
    await tab();
    await expect(
      sections.getByRole("button", { name: "Notifications", exact: true }),
    ).toBeFocused();
    await tab();
    await expect(
      page.getByRole("textbox", { name: "Display name", exact: true }),
    ).toBeFocused();
  }
});

test("Settings edits the local profile inline without publishing to a community", async ({
  page,
  app,
}) => {
  const writes = [];
  page.on("request", (request) => {
    if (/\/api\/relay\/.*\/(profile|sign|publish)$/.test(request.url()))
      writes.push(request.url());
  });
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  const name = page.getByRole("textbox", { name: "Display name", exact: true });
  const picture = page.getByRole("textbox", {
    name: "Picture URL (optional)",
    exact: true,
  });
  const save = button(page, "Save profile");
  await expect(name).toHaveValue("Browser Fixture");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(button(page, "Edit profile")).toHaveCount(0);
  await name.fill("Do not save");
  await button(page, "Plugins").click();
  await expect(name).toBeHidden();
  await button(page, "Profile").click();
  await expect(name).toHaveValue("Do not save");
  await button(page, "Cancel").click();
  await expect(name).toHaveValue("Browser Fixture");
  await name.fill("Discard when leaving Settings");
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await expect(name).toHaveValue("Browser Fixture");
  await name.fill("   ");
  await expect(save).toBeDisabled();
  await name.fill("Updated local profile");
  await picture.fill("http://example.com/avatar.png");
  await expect(save).toBeDisabled();
  await picture.fill("");
  await expect(save).toBeEnabled();
  await name.fill("  Updated local profile  ");
  await save.click();
  await expect(name).toHaveValue("Updated local profile");
  await expect(
    page
      .getByRole("region", { name: "Profile", exact: true })
      .getByRole("status"),
  ).toHaveText("Profile updated.");
  await expect(button(page, "Your profile")).toHaveAttribute(
    "title",
    "Updated local profile",
  );
  await name.fill("Discard after saving");
  await button(page, "Cancel").click();
  await expect(name).toHaveValue("Updated local profile");
  await page.reload();
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await expect(name).toHaveValue("Updated local profile");
  expect(writes).toEqual([]);
});

test("community setup reuses profile fields without changing the local default", async ({
  page,
  app,
}) => {
  const writes = [];
  page.on("request", (request) => {
    if (/\/api\/relay\/.*\/(profile|sign|publish)$/.test(request.url()))
      writes.push(request.url());
  });
  await page.route("**/api/relay/primary/info", (route) =>
    route.fulfill({ json: { name: "Primary", policy: null } }),
  );
  await page.goto(app.origin);
  await button(page, "Switch community").click();
  await button(page, "Add a community").click();
  await page
    .getByRole("textbox", { name: "Relay URL", exact: true })
    .fill("wss://primary.example");
  await button(page, "Continue").click();
  await expect(
    page.getByRole("heading", { name: "Your profile in Primary", exact: true }),
  ).toBeVisible();
  const name = page.getByRole("textbox", { name: "Display name", exact: true });
  const picture = page.getByRole("textbox", {
    name: "Picture URL (optional)",
    exact: true,
  });
  await expect(name).toHaveValue("Fixture Reader");
  await expect(button(page, "Open community")).toBeEnabled();
  await name.fill("Community-only draft");
  await picture.fill("http://example.com/avatar.png");
  await expect(button(page, "Publish profile & open")).toBeDisabled();
  await picture.fill("https://example.com/avatar.png");
  await expect(button(page, "Publish profile & open")).toBeEnabled();
  await button(page, "Close").click();
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await expect(name).toHaveValue("Browser Fixture");
  await expect(picture).toHaveValue("");
  expect(writes).toEqual([]);
});
