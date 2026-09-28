import { wheel } from "./timeline.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });

test("short narrow Settings keeps full plugin rows usable at 200% text size", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 400 });
  await page.addInitScript(() =>
    localStorage.setItem("buzz-font-scale.v1", "2"),
  );
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await button(page, "Plugins").click();
  const frame = page.getByRole("region", { name: "Settings", exact: true });
  const content = page.getByRole("region", { name: "Plugins", exact: true });
  const row = content.getByRole("article").filter({
    has: page.getByRole("heading", { name: "GitHub", exact: true }),
  });
  const toggle = row.getByRole("switch", {
    name: "Enable GitHub",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("html")).toHaveCSS("--buzz-text-scale", "2");
  const bounds = await frame.boundingBox();
  const scroller = frame.locator(":scope > div");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  // Real wheel input must reveal a complete row inside the clipped solid frame.
  // Merely finding a control in the DOM, or scrolling it into a thin strip, fails.
  const visibleTop = Math.max(bounds.y, 0);
  const visibleBottom = Math.min(bounds.y + bounds.height, 400);
  for (let gesture = 0; gesture < 30; gesture++) {
    const target = await row.boundingBox();
    if (
      target.y >= visibleTop + 8 &&
      target.y + target.height <= visibleBottom - 8
    )
      break;
    const distance =
      target.y < visibleTop + 8
        ? target.y - visibleTop - 8
        : target.y + target.height - visibleBottom + 8;
    const before = await scroller.evaluate((element) => element.scrollTop);
    await wheel(
      page,
      Math.sign(distance) * Math.max(Math.abs(distance), 24),
      scroller,
    );
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .not.toBe(before);
  }
  await expect(row).toBeInViewport({ ratio: 1 });
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("settings-short-200-percent.png"),
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-disabled", "false");
  await toggle.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toBeInViewport({ ratio: 1 });
  // The navigation remains reachable after reading and operating the details.
  await page.mouse.wheel(
    0,
    -(await scroller.evaluate((element) => element.scrollHeight)),
  );
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(0);
  await expect(button(page, "Profile")).toBeInViewport({ ratio: 1 });
  await button(page, "Profile").click();
  await expect(button(page, "Profile")).toHaveAttribute("aria-current", "page");

  // Narrow Settings keeps its own navigation reachable without replacing the
  // persistent app sidebar or moving focus out of the selected settings section.
  const pages = page.getByRole("navigation", { name: "Pages" });
  const sidebar = page.getByRole("complementary", { name: "Channel sidebar" });
  await expect(pages).toHaveCount(0);
  const showNavigation = button(page, "Show navigation");
  await expect(showNavigation).toHaveAttribute("aria-expanded", "false");
  await showNavigation.click();
  await expect(sidebar).toBeVisible();
  const inbox = sidebar.getByRole("button", { name: "Inbox", exact: true });
  await inbox.focus();
  await page.keyboard.press("Escape");
  await expect(sidebar).toBeHidden();
  await expect(showNavigation).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(sidebar).toBeVisible();
  await expect(showNavigation).toBeHidden();
  await page.setViewportSize({ width: 480, height: 400 });
  await expect(sidebar).toBeHidden();
  await showNavigation.click();
  await inbox.click();
  await expect(
    page.getByRole("region", { name: "Channels", exact: true }),
  ).toBeVisible();
  await expect(sidebar).toBeVisible();
});

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
  const account = page.getByRole("menu", {
    name: "Fixture Reader",
  });
  const settings = account.getByRole("menuitem", {
    name: "Settings",
    exact: true,
  });
  const statusEntry = account.getByRole("menuitem", {
    name: "Set a status",
    exact: true,
  });
  const feedback = account.getByRole("menuitem", {
    name: "Send feedback",
    exact: true,
  });
  const availability = account.getByRole("button", {
    name: "Availability: Online",
  });
  await expect(avatar).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("menuitem", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await avatar.click();
    await expect(account).toBeInViewport();
    await expect(avatar).toHaveAttribute("aria-expanded", "true");
    await expect(availability).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitemradio", { name: "Online", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitemradio", { name: "Away", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("menuitemradio", { name: "Automatic", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitemradio", { name: "Online", exact: true }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(availability).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(account).toBeHidden();
    await expect(avatar).toBeFocused();
    await avatar.click();
    await avatar.click();
    await expect(account).toBeHidden();
    await avatar.click();
    // The account popup may cover main’s top-left on narrow layouts.
    // Click the lower content area, genuinely outside the popup.
    const main = page.getByRole("main");
    const bounds = await main.boundingBox();
    await main.click({ position: { x: 5, y: bounds.height - 5 } });
    await expect(account).toBeHidden();
    await avatar.focus();
    await page.keyboard.press("Enter");
    await expect(availability).toBeFocused();
    await page.keyboard.press("End");
    await expect(settings).toBeFocused();
    await page.keyboard.press("Home");
    await expect(statusEntry).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(feedback).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(settings).toBeFocused();
    await page.keyboard.press("Home");
    await expect(statusEntry).toBeFocused();
    await tab(true);
    await expect(account).toBeHidden();
    await expect(avatar).toBeFocused();
    await tab(true);
    await expect(button(page, "Search Buzz")).toBeFocused();
  }
  await avatar.focus();
  await page.keyboard.press("Enter");
  await expect(availability).toBeFocused();
  await page.keyboard.press("End");
  await expect(settings).toBeFocused();
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
  const personalGroups = sections.getByRole("button", {
    name: "Personal groups",
    exact: true,
  });
  const hostedCommunities = sections.getByRole("button", {
    name: "Hosted communities",
    exact: true,
  });
  const invites = sections.getByRole("button", {
    name: "Invites",
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
  await personalGroups.click();
  await expect(personalGroups).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Personal groups", exact: true }),
  ).toBeVisible();
  await expect(button(page, "Manage personal groups")).toBeVisible();
  await profile.click();
  // Exercise the real shell's destination allowlist, not just the settings component.
  const agents = sections.getByRole("button", {
    name: "Agents",
    exact: true,
  });
  await agents.click();
  await expect(agents).toHaveAttribute("aria-current", "page");
  const remember = page.getByRole("switch", {
    name: "Remember mentioned agents",
  });
  await expect(remember).toBeChecked();
  await remember.click();
  await expect(remember).not.toBeChecked();
  await profile.click();
  await agents.click();
  await expect(remember).not.toBeChecked();
  await profile.click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await profile.focus();
    await tab();
    await expect(personalGroups).toBeFocused();
    await tab();
    await expect(hostedCommunities).toBeFocused();
    await tab();
    await expect(invites).toBeFocused();
    await tab();
    await expect(
      sections.getByRole("button", { name: "Appearance", exact: true }),
    ).toBeFocused();
    await plugins.focus();
    await page.keyboard.press("Enter");
    await expect(plugins).toHaveAttribute("aria-current", "page");
    await expect(profile).not.toHaveAttribute("aria-current");
    await expect(plugins).toBeFocused();
    await expect(profileContent).toHaveCount(0);
    await expect(pluginContent).toBeVisible();
    await expect(
      page.getByRole("switch", { name: "Enable Projects" }),
    ).toBeVisible();
    const settingsRegion = page.getByRole("region", {
      name: "Settings",
      exact: true,
    });
    await expect(settingsRegion).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await expect(settingsRegion).toHaveCSS("border-radius", "24px");
    const frame = await settingsRegion.boundingBox();
    expect(frame.height).toBeGreaterThan(700);
    const navigation = await sections.boundingBox();
    const content = await pluginContent.boundingBox();
    expect(navigation).not.toBeNull();
    expect(content).not.toBeNull();
    if (width === 1280) {
      expect(navigation.x + navigation.width).toBeLessThan(content.x);
      expect(content.y - frame.y).toBe(25);
    } else {
      expect(navigation.y + navigation.height).toBeLessThan(content.y);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    }
    await page.screenshot({
      path: testInfo.outputPath(`settings-${width}.png`),
    });
    await profile.focus();
    await expect(profile).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(profile).toHaveAttribute("aria-current", "page");
    await expect(profileContent).toBeVisible();
    await expect(pluginContent).toHaveCount(0);
    await tab();
    await expect(personalGroups).toBeFocused();
    await tab();
    await expect(hostedCommunities).toBeFocused();
    await tab();
    await expect(invites).toBeFocused();
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
      sections.getByRole("button", { name: "Shortcuts", exact: true }),
    ).toBeFocused();
    await tab();
    await expect(agents).toBeFocused();
    await tab();
    await expect(plugins).toBeFocused();
    await tab();
    await expect(button(page, "Edit avatar")).toBeFocused();
    await tab();
    await expect(
      page.getByRole("textbox", { name: "Display name", exact: true }),
    ).toBeFocused();
  }
});

test("Settings loads and publishes the selected community profile", async ({
  page,
  app,
  browserName,
}) => {
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const writes = [];
  const profiles = [];
  let pendingProfile;
  await page.route("**/api/relay/primary/profile", async (route) => {
    profiles.push(route.request().postDataJSON());
    const response = await new Promise((resolve) => {
      pendingProfile = resolve;
    });
    pendingProfile = undefined;
    if (response) await route.fulfill(response);
    else await route.continue();
  });
  page.on("request", (request) => {
    if (/\/api\/relay\/.*\/(profile|sign|publish)$/.test(request.url()))
      writes.push(request.url());
  });
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Fixture Reader" })).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  const name = page.getByRole("textbox", { name: "Display name", exact: true });
  const picture = page.getByRole("textbox", {
    name: "Picture URL (optional)",
    exact: true,
  });
  const save = button(page, "Save");
  await expect(save).toHaveCount(0);
  await expect(name).toHaveValue("Fixture Reader");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(button(page, "Edit profile")).toHaveCount(0);
  await name.fill("Do not save");
  await expect(name).toHaveValue("Do not save");
  await button(page, "Plugins").click();
  await expect(name).toBeHidden();
  await button(page, "Profile").click();
  await expect(name).toHaveValue("Do not save");
  await button(page, "Cancel").focus();
  await page.keyboard.press("Enter");
  await expect(name).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("textbox", { name: "Profile description (optional)" }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("textbox", { name: "Public key (hex)", exact: true }),
  ).toBeFocused();
  await expect(name).toHaveValue("Fixture Reader");
  await name.fill("Discard when leaving Settings");
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await button(page, "Inbox").click();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Fixture Reader" })).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  await expect(name).toHaveValue("Fixture Reader");
  await name.fill("   ");
  await expect(save).toBeDisabled();
  await name.fill("Updated community profile");
  await button(page, "Edit avatar").click();
  await picture.fill("http://example.com/avatar.png");
  await expect(button(page, "Done")).toBeDisabled();
  await picture.fill("");
  await button(page, "Done").click();
  await expect(save).toBeEnabled();
  await name.fill("  Updated community profile  ");
  await save.focus();
  await page.keyboard.press("Enter");
  try {
    await expect.poll(() => profiles.length).toBe(1);
    await expect(save).toHaveAttribute("aria-busy", "true");
    await expect(save).toBeFocused();
    await expect(name).toBeDisabled();
    await expect(button(page, "Cancel")).toBeDisabled();
    // Loading blocks repeated submission without dropping keyboard focus.
    await page.keyboard.press("Enter");
  } finally {
    pendingProfile?.({
      json: { accepted: false, message: "Publication unavailable" },
    });
  }
  await expect(page.getByRole("alert")).toContainText(
    "Publication unavailable",
  );
  await expect(save).toBeFocused();
  await expect(save).toBeEnabled();
  await page.keyboard.press("Enter");
  try {
    await expect.poll(() => profiles.length).toBe(2);
    await expect(save).toHaveAttribute("aria-busy", "true");
    await expect(save).toBeFocused();
  } finally {
    pendingProfile?.();
  }
  await expect(name).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("textbox", { name: "Profile description (optional)" }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("textbox", { name: "Public key (hex)", exact: true }),
  ).toBeFocused();
  await expect(name).toHaveValue("Updated community profile");
  await expect(save).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Profile updated" }),
  ).toBeVisible();
  await expect(name).toHaveValue("Updated community profile");
  await button(page, "Your profile").hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Updated community profile",
  );
  await expect(button(page, "Your profile")).toHaveAccessibleDescription(
    "Updated community profile",
  );
  await name.fill("Discard after saving");
  await button(page, "Cancel").click();
  await expect(name).toHaveValue("Updated community profile");
  // A different local default must not replace the published community profile.
  await page.evaluate((viewer) => {
    const key = `buzz-client.v1:${viewer}`;
    const saved = JSON.parse(localStorage.getItem(key));
    saved.profile.name = "Local default only";
    localStorage.setItem(key, JSON.stringify(saved));
  }, app.viewer);
  await page.reload();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("menu", { name: "Updated community profile" }),
  ).toBeHidden();
  await expect(page.getByRole("main")).toBeFocused();
  // Both Settings and the header re-read the signed community state after reload.
  await expect(name).toHaveValue("Updated community profile");
  await button(page, "Your profile").hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Updated community profile",
  );
  expect(writes.filter((url) => url.endsWith("/profile"))).toHaveLength(2);
  for (const profile of profiles)
    expect(profile).toEqual(
      expect.objectContaining({
        name: "Updated community profile",
        picture: "",
        existing: expect.objectContaining({ name: "Fixture Reader" }),
      }),
    );
});

test("discarding community setup leaves the published profile unchanged", async ({
  page,
  app,
}) => {
  const writes = [];
  page.on("request", (request) => {
    if (/\/api\/relay\/.*\/(profile|sign|publish)$/.test(request.url()))
      writes.push(request.url());
  });
  await page.route("https://example.com/avatar.png", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="navy"/></svg>',
    }),
  );
  await page.route("**/api/relay/primary/info", (route) =>
    route.fulfill({ json: { name: "Primary", policy: null } }),
  );
  await page.goto(app.origin);
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
  await button(page, "Edit avatar").click();
  await picture.fill("http://example.com/avatar.png");
  await expect(button(page, "Done")).toBeDisabled();
  await picture.fill("https://example.com/avatar.png");
  await button(page, "Done").click();
  await expect(button(page, "Publish profile & open")).toBeEnabled();
  await button(page, "Close").click();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(name).toHaveValue("Fixture Reader");
  await button(page, "Edit avatar").click();
  await expect(picture).toHaveValue("");
  await button(page, "Done").click();
  expect(writes).toEqual([]);
});
