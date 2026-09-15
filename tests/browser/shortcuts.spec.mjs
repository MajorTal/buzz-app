import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ pluginFixtures: true });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const font = (locator) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
const mod = async (page) =>
  (await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform)))
    ? "Meta"
    : "Control";
const scale = async (page, expected) =>
  expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--buzz-text-scale"),
      ),
    )
    .toBe(String(expected));

test("real Settings keys respect dialogs and modifiers, focus main, and preserve drafts", async ({
  page,
  app,
}) => {
  await open(page, app);
  const modifier = await mod(page);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("Keep my draft");
  await page.keyboard.press(`${modifier}+Shift+,`);
  await expect(composer).toBeVisible();
  await button(page, "Find a page").click();
  await page.keyboard.press(`${modifier}+,`);
  await expect(page.getByRole("dialog", { name: "Find a page" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await composer.focus();
  await page.keyboard.press(`${modifier}+,`);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toBeFocused();
  await button(page, "Messages").first().click();
  await expect(composer).toHaveJSProperty("value", "Keep my draft");
});

test("zoom keys resize real message/composer text, not window or spacing, and persist/reset", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const modifier = await mod(page);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const message = page.locator("[data-message-id] p").last();
  const base = { composer: await font(composer), message: await font(message) };
  const header = await page.locator(".shell-header").boundingBox();
  const node = await composer.elementHandle();
  await composer.fill("Unsent zoom draft");
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  expect(await font(composer)).toBeCloseTo(base.composer * 1.1, 1);
  expect(await font(message)).toBeCloseTo(base.message * 1.1, 1);
  await page.keyboard.press(`${modifier}+Shift+=`);
  await scale(page, 1.2);
  await page.keyboard.press(`${modifier}+-`);
  await scale(page, 1.1);
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  for (const init of [
    { isComposing: true },
    { altKey: true },
    { ctrlKey: true, metaKey: true },
  ]) {
    const prevented = await composer.evaluate((el, init) => {
      const event = new KeyboardEvent("keydown", {
        key: "=",
        metaKey: /Mac|iPhone|iPad/.test(navigator.platform),
        ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform),
        bubbles: true,
        cancelable: true,
        ...init,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }, init);
    expect(prevented).toBe(false);
    await scale(page, 1);
  }
  // Locally handled events must win before the window's bubbling dispatcher.
  await composer.evaluate((el) => {
    const prevent = (event) => {
      if (event.key === "=") {
        event.preventDefault();
        el.removeEventListener("keydown", prevent);
      }
    };
    el.addEventListener("keydown", prevent);
  });
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1);
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  expect(await node.evaluate((el) => el.isConnected)).toBe(true);
  await expect(composer).toHaveJSProperty("value", "Unsent zoom draft");
  expect((await page.locator(".shell-header").boundingBox()).height).toBe(
    header.height,
  );
  expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
  await page.reload();
  await scale(page, 1.1);
  await button(page, "Messages").first().click();
  await expect(composer).toHaveJSProperty("value", "Unsent zoom draft");
  await composer.focus();
  for (let i = 0; i < 15; i++) await page.keyboard.press(`${modifier}+=`);
  await scale(page, 2);
  expect(await font(composer)).toBeCloseTo(base.composer * 2, 1);
  expect(await font(message)).toBeCloseTo(base.message * 2, 1);
  await expect(composer).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("text-200-percent.png") });
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  expect(await font(composer)).toBe(base.composer);
  for (let i = 0; i < 5; i++) await page.keyboard.press(`${modifier}+-`);
  await scale(page, 0.8);
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Appearance").click();
  await expect(page.getByRole("status", { name: "Text size" })).toHaveText(
    "80%",
  );
  await button(page, "Reset text size").click();
  await scale(page, 1);
});

test("independent plugin consumes injected shortcuts; disable/re-enable and editor guards work", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const modifier = await mod(page);
  await button(page, "Shortcut counter").first().click();
  const count = page.getByRole("status");
  await expect(count).toHaveText("Shortcut count: 0");
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(count).toHaveText("Shortcut count: 1");
  const input = page.getByRole("textbox", { name: "Shortcut typing guard" });
  await input.fill("Keep typing");
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(count).toHaveText("Shortcut count: 1");
  await page.evaluate(() => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    root.append(input);
    input.focus();
  });
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(count).toHaveText("Shortcut count: 1");
  // Core zoom explicitly opts into editable targets, including Shadow DOM.
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  await button(page, "Find a page").click();
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(count).toHaveText("Shortcut count: 1");
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Plugins").click();
  const toggle = page.getByRole("switch", { name: "Enable Shortcut counter" });
  await toggle.click();
  await expect(button(page, "Shortcut counter")).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+k`);
  await toggle.click();
  await button(page, "Shortcut counter").first().click();
  await expect(count).toHaveText("Shortcut count: 0");
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(count).toHaveText("Shortcut count: 1");
});

test("a shadow-root modal blocks Settings and plugin bindings but allows text zoom", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const modifier = await mod(page);
  await button(page, "Shortcut counter").first().click();
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "shadow-modal";
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const dialog = document.createElement("dialog");
    const control = document.createElement("button");
    control.textContent = "Modal control";
    dialog.append(control);
    root.append(dialog);
    dialog.showModal();
    control.focus();
  });
  const control = button(page, "Modal control");
  await expect(control).toBeFocused();
  await page.keyboard.press(`${modifier}+,`);
  await expect(control).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(page.getByRole("status")).toHaveText("Shortcut count: 0");
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.getElementById("shadow-modal").remove());
  await page.getByRole("main").focus();
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(page.getByRole("status")).toHaveText("Shortcut count: 1");
});
