import { test, expect } from "./fixture.mjs";
import { open, anchor, expectAnchor } from "./timeline.mjs";

const key = "buzz-appearance.v1";
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function settings(page) {
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Appearance").click();
}
async function expectMode(page, mode) {
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
  await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    mode === "dark" ? "rgb(17, 24, 29)" : "rgb(231, 240, 239)",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    mode === "dark" ? "#11181d" : "#e7f0ef",
  );
}

test("Appearance changes and restores both modes, native keyboard controls, dialogs and narrow layout", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await expectMode(page, "light");
  await settings(page);
  const light = page.getByRole("radio", { name: "Light", exact: true });
  const dark = page.getByRole("radio", { name: "Dark", exact: true });
  await expect(light).toBeChecked();
  await light.focus();
  await page.keyboard.press("ArrowRight");
  await expect(dark).toBeChecked();
  await expect(dark).toBeFocused();
  await expectMode(page, "dark");
  expect(
    await page
      .locator(".shell-tab")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
  ).toBe("rgb(230, 237, 240)");
  await expect(button(page, "Appearance")).toHaveCSS(
    "background-color",
    "rgb(27, 37, 43)",
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    "dark",
  );
  for (const mode of ["dark", "light"]) {
    await page
      .getByRole("radio", {
        name: mode === "dark" ? "Dark" : "Light",
        exact: true,
      })
      .check();
    await expectMode(page, mode);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(
        page.getByRole("region", { name: "Appearance", exact: true }),
      ).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(`appearance-${mode}-${width}.png`),
      });
    }
    await button(page, "Find a page").click();
    const dialog = page.getByRole("dialog", { name: "Find a page" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS(
      "background-color",
      mode === "dark" ? "rgb(27, 37, 43)" : "rgb(255, 255, 255)",
    );
    await page.keyboard.press("Escape");
  }
  await dark.check();
  await page.reload();
  await expectMode(page, "dark");
  await settings(page);
  await expect(dark).toBeChecked();
});

test("storage denial is visible and retryable; another window updates a live conversation without remount", async ({
  page,
  context,
  app,
}, testInfo) => {
  await open(page, app);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Unsent appearance draft");
  const before = await anchor(page);
  const node = await composer.elementHandle();
  const sessions = [...app.report.sessions];
  await button(page, "Insert emoji").click();
  const emojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await emojiSearch.fill("grinning");
  const emojiNode = await emojiSearch.elementHandle();
  await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
    "data-theme",
    "light",
  );
  const other = await context.newPage();
  try {
    await other.goto(app.origin);
    await settings(other);
    await other.evaluate((key) => {
      const original = Storage.prototype.setItem;
      window.restoreStorage = () => {
        Storage.prototype.setItem = original;
      };
      Storage.prototype.setItem = function (k, v) {
        if (k === key) throw new DOMException("denied", "QuotaExceededError");
        return original.call(this, k, v);
      };
    }, key);
    await other.getByRole("radio", { name: "Dark", exact: true }).check();
    await expectMode(other, "dark");
    await expect(other.getByRole("alert")).toContainText("could not be saved");
    await expectMode(page, "light");
    await other.evaluate(() => window.restoreStorage());
    await button(other, "Retry saving appearance").click();
    await expect(other.getByRole("alert")).toHaveCount(0);
    await expectMode(page, "dark");
    await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    await expect(emojiSearch).toHaveValue("grinning");
    expect(await emojiNode.evaluate((el) => el.isConnected)).toBe(true);
    await expect(composer).toHaveJSProperty("value", "Unsent appearance draft");
    expect(await node.evaluate((el) => el.isConnected)).toBe(true);
    await expectAnchor(page, before);
    // The second window legitimately creates its own session; a mode change must not add a third.
    expect(app.report.sessions.length).toBe(sessions.length + 1);
    await page.screenshot({ path: testInfo.outputPath("messages-dark.png") });
    await other.getByRole("radio", { name: "Light", exact: true }).check();
    await expectMode(page, "light");
    await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
      "data-theme",
      "light",
    );
    await emojiSearch.press("Escape");
    await expectAnchor(page, before);
    await page.screenshot({ path: testInfo.outputPath("messages-light.png") });
  } finally {
    await other.close();
  }
});

test("saved dark document paints before the application module is allowed to execute", async ({
  page,
  app,
}) => {
  const relayRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/relay/"))
      relayRequests.push(request.url());
  });
  // Seed only persisted input before the first document. Booting a live app
  // just to save this preference races its pending relay reads against goto.
  await page.addInitScript((key) => localStorage.setItem(key, "dark"), key);
  // Completing a no-op module keeps React from executing without leaving a
  // pending script request. WebKit stalls animation frames when that pending
  // request coexists with @font-face rules, even after styles are computed.
  await page.route(/\/assets\/.*\.js$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "/* Application execution deliberately withheld. */",
    }),
  );
  try {
    await page.goto(app.origin, { waitUntil: "commit" });
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      "rgb(17, 24, 29)",
    );
    expect(await page.locator("#root").innerHTML()).toBe("");
    // Observe the painted document for two frames with the entire React bundle still withheld.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      "rgb(17, 24, 29)",
    );
    // Pre-paint coverage must never start (then tear down) a relay session.
    expect(relayRequests).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.reload();
  await expect(button(page, "Your profile")).toBeVisible();
  await expectMode(page, "dark");
});

test("production startup owns keyboard modality", async ({
  page,
  app,
  browserName,
}) => {
  await page.goto(app.origin);
  await button(page, "Your profile").click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
  await page.mouse.click(2, 2);
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
});

test("compiled host preserves compatibility utility meanings", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  // Diagnostic nodes use the production stylesheet, not fixture-generated CSS.
  // Opposing inherited color prevents a missing text utility from passing.
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "style-contract";
    probe.innerHTML = `<code id="old-code">Old code</code><span id="old-mono" class="font-mono">Old mono</span><div data-buzz-ui><code id="new-mono" class="font-mono">New mono</code><div class="text-secondary"><span id="primary-text" class="text-primary">Text</span></div><div id="primary-border" class="border border-primary">Border</div></div><button id="old-primary" class="bg-primary text-on-primary rounded-xl hover:bg-primary-hover">Old primary</button>`;
    document.body.append(probe);
  });
  for (const mode of ["Light", "Dark"]) {
    await settings(page);
    await page.getByRole("radio", { name: mode, exact: true }).check();
    await expect(page.locator("#primary-text")).toHaveCSS(
      "color",
      mode === "Light" ? "rgb(10, 10, 10)" : "rgb(245, 245, 245)",
    );
    await expect(page.locator("#primary-border")).toHaveCSS(
      "border-top-color",
      mode === "Light" ? "rgb(232, 232, 232)" : "rgb(51, 51, 51)",
    );
    await expect(page.locator("#old-primary")).toHaveCSS(
      "background-color",
      mode === "Light" ? "rgb(49, 63, 67)" : "rgb(214, 227, 235)",
    );
    await expect(page.locator("#old-primary")).toHaveCSS(
      "border-radius",
      "12px",
    );
    for (const id of ["old-code", "old-mono"]) {
      await expect(page.locator(`#${id}`)).toHaveCSS(
        "font-family",
        /ui-monospace/,
      );
      await expect(page.locator(`#${id}`)).not.toHaveCSS(
        "font-family",
        /JetBrains/,
      );
    }
    await expect(page.locator("#new-mono")).toHaveCSS(
      "font-family",
      /JetBrains Mono/,
    );
  }
});
