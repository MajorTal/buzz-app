import { openPage, pageChoices } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ pluginFixtures: true, historyCounts: { alpha: 1, beta: 0 } });
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
  await button(page, "Search Buzz").click();
  await page.keyboard.press(`${modifier}+,`);
  await expect(page.getByRole("dialog", { name: "Search Buzz" })).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: "Settings",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
  await expect(button(page, "Search Buzz")).toBeFocused();
  await composer.focus();
  await page.keyboard.press(`${modifier}+,`);
  await expect(
    page.getByRole("region", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toBeFocused();
  await openPage(page, "Messages");
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
  await openPage(page, "Messages");
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
  await button(page, "Reset text size").focus();
  await page.keyboard.press("Enter");
  await scale(page, 1);
  await expect(button(page, "Increase text size")).toBeFocused();
  // At 200%, the handoff target is disabled until the reset commit finishes.
  for (const reset of ["keyboard", "external", "external-unfocused"]) {
    for (let i = 0; i < 10; i++)
      await button(page, "Increase text size").click();
    await scale(page, 2);
    await expect(button(page, "Increase text size")).toBeDisabled();
    const light = page.getByRole("radio", { name: "Light", exact: true });
    await (reset === "external-unfocused"
      ? light
      : button(page, "Reset text size")
    ).focus();
    if (reset === "keyboard") await page.keyboard.press("Enter");
    else
      await page.evaluate(() => {
        localStorage.setItem("buzz-font-scale.v1", "1");
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "buzz-font-scale.v1",
            newValue: "1",
            storageArea: localStorage,
          }),
        );
      });
    await scale(page, 1);
    await expect(button(page, "Reset text size")).toHaveCount(0);
    await expect(
      reset === "external-unfocused"
        ? light
        : button(page, "Increase text size"),
    ).toBeFocused();
  }
});

test("independent plugin consumes injected shortcuts; disable/re-enable and editor guards work", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const modifier = await mod(page);
  await openPage(page, "Shortcut counter");
  const count = page.getByRole("main").getByRole("status");
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
  await button(page, "Search Buzz").click();
  await page.keyboard.press(`${modifier}+Shift+k`);
  // Base UI hides the background from assistive technology while modal.
  await expect(
    page
      .getByRole("main", { includeHidden: true })
      .getByRole("status", { includeHidden: true }),
  ).toHaveText("Shortcut count: 1");
  await page.keyboard.press("Escape");
  // Dismissal and focus restoration finish asynchronously. The host correctly
  // suppresses Settings while a closing modal still owns the keyboard.
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
  await expect(button(page, "Search Buzz")).toBeFocused();
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Plugins").click();
  const toggle = page.getByRole("switch", { name: "Enable Shortcut counter" });
  await toggle.click();
  const choices = await pageChoices(page);
  await expect(
    choices.getByRole("option", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    choices.getByRole("option", { name: "Shortcut counter", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+k`);
  await toggle.click();
  await openPage(page, "Shortcut counter");
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
  await openPage(page, "Shortcut counter");
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
    page.getByRole("region", {
      name: "Settings",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "Shortcut count: 0",
  );
  await page.keyboard.press(`${modifier}+=`);
  await scale(page, 1.1);
  await page.keyboard.press(`${modifier}+0`);
  await scale(page, 1);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.getElementById("shadow-modal").remove());
  await page.getByRole("main").focus();
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "Shortcut count: 1",
  );
});

test("Settings → Shortcuts rebinds a plugin shortcut live, blocks host conflicts, persists and resets", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const modifier = await mod(page);
  const spokenModifiers =
    modifier === "Meta" ? "Shift Command" : "Control Shift";
  const title = "Increment shortcut counter";
  await openPage(page, "Shortcut counter");
  const count = page.getByRole("main").getByRole("status");
  await expect(count).toHaveText("Shortcut count: 0");
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(count).toHaveText("Shortcut count: 1");
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Shortcuts").click();
  const region = page.getByRole("region", { name: "Shortcuts", exact: true });
  await expect(
    region.getByRole("heading", { name: "Shortcut counter", exact: true }),
  ).toBeVisible();
  await expect(
    region.getByRole("article", { name: "Go back", exact: true }),
  ).toHaveCount(1);
  await expect(
    region.getByRole("article", { name: "Go forward", exact: true }),
  ).toHaveCount(1);
  const row = region.getByRole("article", { name: title });
  await expect(
    row.getByText(`${spokenModifiers} K`, { exact: true }),
  ).toBeAttached();
  await button(row, `Change shortcut for ${title}`).click();
  const listening = page.getByRole("textbox", {
    name: `New shortcut for ${title}`,
  });
  await expect(listening).toBeFocused();
  // The chord being listened for goes to the capture control, not the dispatcher.
  await page.keyboard.press(`${modifier}+k`);
  await expect(row.getByRole("alert")).toContainText("Search Buzz");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
  await expect(listening).toBeFocused();
  await page.keyboard.press(`${modifier}+Shift+u`);
  await expect(listening).toHaveCount(0);
  await expect(row.getByText("Modified")).toBeVisible();
  await expect(
    row.getByText(`${spokenModifiers} U`, { exact: true }),
  ).toBeAttached();
  await expect(button(row, `Reset shortcut for ${title}`)).toBeVisible();
  await expect(button(row, `Change shortcut for ${title}`)).toBeFocused();
  await openPage(page, "Shortcut counter");
  await expect(count).toHaveText("Shortcut count: 1");
  await page.keyboard.press(`${modifier}+Shift+k`);
  await page.keyboard.press(`${modifier}+Shift+u`);
  await expect(count).toHaveText("Shortcut count: 2");
  await page.reload();
  await openPage(page, "Shortcut counter");
  await expect(count).toHaveText("Shortcut count: 0");
  await page.keyboard.press(`${modifier}+Shift+u`);
  await expect(count).toHaveText("Shortcut count: 1");
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Shortcuts").click();
  await button(row, `Reset shortcut for ${title}`).click();
  await expect(row.getByText("Modified")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reset all shortcuts", exact: true }),
  ).toBeDisabled();
  await openPage(page, "Shortcut counter");
  await page.keyboard.press(`${modifier}+Shift+u`);
  await page.keyboard.press(`${modifier}+Shift+k`);
  await expect(count).toHaveText("Shortcut count: 2");
});

// Browser-only: actual Settings gutters, flex wrapping and keyboard focus paint
// cannot be established by jsdom. Reuse one app for the layout/theme samples.
test("shortcut capture keeps its title and keyboard focus visible, with neutral notices and a Tab exit", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  const modifier = await mod(page);
  await button(page, "Search Buzz").waitFor();
  await page.keyboard.press(`${modifier}+,`);
  await button(page, "Shortcuts").click();
  const row = page.getByRole("article", { name: "Open Settings", exact: true });
  const change = button(row, "Change shortcut for Open Settings");
  const input = row.getByRole("textbox", {
    name: "New shortcut for Open Settings",
  });
  const title = row.getByRole("heading", {
    name: "Open Settings",
    exact: true,
  });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      for (const scale of [1, 2]) {
        await page.evaluate(
          (scale) =>
            document.documentElement.style.setProperty(
              "--buzz-text-scale",
              String(scale),
            ),
          scale,
        );
        // Enter capture through real keyboard navigation, not a pointer click.
        await change.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(change).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(input).toBeFocused();
        await expect(input).toHaveCSS("outline-style", "solid");
        await expect(input).toHaveCSS("outline-width", "2px");
        await expect(input).toHaveAccessibleDescription(
          /Press Escape to cancel/,
        );
        const focusColor = await input.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--border-focus)";
          element.parentElement.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        });
        await expect(input).toHaveCSS("outline-color", focusColor);
        await page.evaluate(() => document.fonts.ready);
        const headingBox = await title.boundingBox();
        const inputBox = await input.boundingBox();
        const rowBox = await row.boundingBox();
        const textBoxes = await title.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return [...range.getClientRects()].map(({ x, y, width, height }) => ({
            x,
            y,
            width,
            height,
          }));
        });
        for (const box of textBoxes) {
          expect(box.x + box.width).toBeLessThanOrEqual(
            headingBox.x + headingBox.width + 1,
          );
          expect(
            box.y + box.height <= inputBox.y || box.x + box.width <= inputBox.x,
          ).toBe(true);
        }
        expect(
          headingBox.y + headingBox.height <= inputBox.y ||
            headingBox.x + headingBox.width <= inputBox.x,
        ).toBe(true);
        for (const box of [
          inputBox,
          await button(row, "Cancel changing Open Settings").boundingBox(),
        ]) {
          expect(box.x).toBeGreaterThanOrEqual(rowBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(
            rowBox.x + rowBox.width,
          );
        }
        // A rejected chord stays in capture, announces why, and stays neutral.
        await page.keyboard.press(`${modifier}+k`);
        const alert = row.getByRole("alert");
        await expect(alert).toContainText("already used by Search Buzz");
        await expect(input).toHaveAccessibleDescription(
          /already used by Search Buzz/,
        );
        await expect(alert).toHaveCSS(
          "color",
          await title.evaluate((el) => getComputedStyle(el).color),
        );
        if (scale === 1)
          await page.screenshot({
            path: testInfo.outputPath(`capture-${mode}-${width}.png`),
          });
        await page.keyboard.press("Tab");
        await expect(input).toHaveCount(0);
        await expect(change).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(input).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(change).toBeFocused();
      }
    }
    await page.keyboard.press("Enter");
    await expect(input).toBeFocused();
    await page.keyboard.press(`${modifier}+z`);
    await expect(row.getByRole("alert")).toContainText(
      "message editor handles",
    );
    await expect(row.getByRole("alert")).toHaveCSS(
      "color",
      await title.evaluate((el) => getComputedStyle(el).color),
    );
    await button(row, "Reset shortcut for Open Settings").click();
  }
});
