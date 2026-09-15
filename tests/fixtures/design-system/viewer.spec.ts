import { expect, test } from "@playwright/test";
import { COMPONENTS } from "../../../src/shared/design-system/ui/registry";

const viewer = "/tests/fixtures/design-system.html";

test("built viewer loads every specimen and foundation without app connections", async ({
  page,
}) => {
  const failures: string[] = [];
  const sockets: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.goto(viewer);
  await expect(
    page.getByRole("heading", { name: "Buzz Design System", exact: true }),
  ).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Design system" });
  for (const component of COMPONENTS) {
    await nav.getByRole("link", { name: component.name, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: component.name, exact: true }).first(),
    ).toBeVisible();
  }
  for (const name of [
    "Color",
    "Token table",
    "Typography",
    "Spacing",
    "Radius",
    "Elevation",
    "Glass",
    "Motion",
    "Base UI backing",
    "Foundation alignment",
    "Component adoption",
    "Maintaining the system",
    "DESIGN.md",
    "AGENTS.md",
  ]) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(page.locator("main h1")).toBeVisible();
    await page.reload();
    await expect(page.locator("main h1")).toBeVisible();
  }
  await expect(
    nav.getByRole("link", { name: /Composer|Conversation|Agent work/ }),
  ).toHaveCount(0);
  expect(failures).toEqual([]);
  expect(sockets).toEqual([]);
});

test("foundation proposals are independent, local, and usable in both modes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/foundation-alignment`);
  const current = page.getByRole("region", {
    name: "Current tokens",
    exact: true,
  });
  const proposal = page.getByRole("region", {
    name: "Selected proposal",
    exact: true,
  });
  const color = page.getByRole("switch", { name: "Status color" });
  const reading = page.getByRole("switch", { name: "Larger reading text" });
  const spacing = page.getByRole("switch", { name: "More section space" });

  for (const mode of ["light", "dark"]) {
    const theme = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await theme.count()) await theme.click();
    await expect(proposal.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "16px",
    );
    await expect(proposal.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "32px",
    );
    const neutral = await current
      .locator("[data-status]")
      .evaluate((el) => getComputedStyle(el).color);
    await expect(proposal.locator("[data-status]")).toHaveCSS("color", neutral);

    await color.click();
    await expect(proposal.locator("[data-status]")).not.toHaveCSS(
      "color",
      neutral,
    );
    await expect(proposal.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "16px",
    );
    await expect(proposal.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "32px",
    );
    await reading.focus();
    await page.keyboard.press("Space");
    await expect(reading).toBeChecked();
    await expect(proposal.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "20px",
    );
    await spacing.click();
    await expect(proposal.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "64px",
    );
    await expect(current.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "16px",
    );
    await expect(current.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "32px",
    );
    await expect(current.locator("[data-status]")).toHaveCSS("color", neutral);

    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("table")).toHaveCount(3);
      await expect(page.getByRole("table").first()).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await color.click();
    await reading.click();
    await spacing.focus();
    await page.keyboard.press("Space");
    await expect(spacing).not.toBeChecked();
  }
  await proposal
    .getByRole("button", { name: "Follow project", exact: true })
    .click();
  await expect(
    proposal.getByRole("button", { name: "Following project" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    current.getByRole("button", { name: "Follow project", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(color).not.toBeChecked();
  await expect(reading).not.toBeChecked();
  await expect(spacing).not.toBeChecked();
});

test("narrow, intermediate and wide layouts preserve theme and keyboard interaction", async ({
  page,
  browserName,
}) => {
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${viewer}#/design/components/button`);
    const toggle = page.getByRole("button", { name: "Use dark mode" });
    if (await toggle.count()) await toggle.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Use light mode" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  const primary = page
    .getByRole("button", { name: "Save", exact: true })
    .first();
  await primary.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }).nth(1),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
  await primary.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }).nth(1),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
});

test("switch keyboard activation matches pointer state and focus in both modes", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const switches = page.getByRole("switch", { name: "Show agent activity" });
  const control = switches.nth(0);
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["light", "dark"]) {
      const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
      if (await toggle.count()) await toggle.click();
      await expect(control).not.toBeChecked();
      await control.click();
      await expect(control).toBeChecked();
      await expect(control).toHaveCSS("outline-style", "none");
      await page.keyboard.press(tab);
      await expect(switches.nth(1)).toBeFocused();
      await page.keyboard.press(`Shift+${tab}`);
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS("outline-style", "solid");
      await expect(control).toHaveCSS("outline-width", "2px");
      await page.keyboard.press("Space");
      await expect(control).not.toBeChecked();
      await page.keyboard.press("Enter");
      await expect(control).toBeChecked();
      await control.click();
      await expect(control).not.toBeChecked();
    }
  }
});

test("disabled switch exposes its state, skips Tab and rejects activation", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const switches = page.getByRole("switch", { name: "Show agent activity" });
  const disabled = switches.nth(2);
  await expect(disabled).toBeDisabled();
  await expect(disabled).not.toBeChecked();
  await switches.nth(1).click();
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  await expect(disabled).not.toBeFocused();
  await disabled.click({ force: true });
  await disabled.press("Space");
  await disabled.press("Enter");
  await expect(disabled).not.toBeChecked();
});

test("viewer does not replace host styles or appearance ownership", async ({
  page,
  context,
}) => {
  await page.goto("http://localhost:1444");
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  const readHost = () =>
    page.evaluate(() => ({
      storage: JSON.stringify(
        Object.entries(localStorage)
          .filter(([key]) => key !== "buzz-design-viewer-color-scheme")
          .sort(),
      ),
      mode: document.documentElement.getAttribute("data-color-mode"),
      background: getComputedStyle(document.body).backgroundColor,
      systemToken: getComputedStyle(document.documentElement).getPropertyValue(
        "--purple-9",
      ),
    }));
  const before = await readHost();
  expect(before.systemToken.trim()).toBe("#8e4ec6");
  await page.goto("http://localhost:1445");
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  const sameOriginBefore = await readHost();
  const other = await context.newPage();
  await other.goto(`http://localhost:1445${viewer}`);
  await other.getByRole("button", { name: /Use (dark|light) mode/ }).click();
  expect(await readHost()).toEqual(sameOriginBefore);
  await other.close();
});

test("documentation retains table guidance and storage failure stays usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage denied");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage denied");
    };
  });
  await page.goto(`${viewer}#/design/design-guide`);
  // A real cell in a real row, so run-on prose or a dropped table both fail.
  const stepRow = page
    .locator("main table tbody tr")
    .filter({ hasText: "coloured text on a neutral surface" });
  await expect(stepRow.locator("td").first()).toHaveText("12");
  await expect(
    page.locator("main table thead th").filter({ hasText: "step" }),
  ).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText("|---|");
  // A token is one word: it may sit on its own line, never break across two.
  const split = await page
    .locator("main table code")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getClientRects().length > 1)
        .map((node) => node.textContent ?? ""),
    );
  expect(split).toEqual([]);
  await expect(page.getByRole("status")).toContainText(
    "Appearance is temporary",
  );
  const before = await page.locator("html").getAttribute("class");
  await page.getByRole("button", { name: /Use (light|dark) mode/ }).click();
  await expect
    .poll(() => page.locator("html").getAttribute("class"))
    .not.toBe(before);
  await expect(page.getByRole("status")).toContainText("Toggle again to retry");
});

test("built component references retain anatomy and fallback identity", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/tabs`);
  const selectedTabRow = page
    .locator("tbody tr")
    .filter({ hasText: "Unselected tab" })
    .first();
  await expect(selectedTabRow).toContainText("text-secondary");
  await expect(selectedTabRow.locator("td")).toHaveCount(6);

  await page.goto(`${viewer}#/design/components/avatar`);
  await expect(page.getByRole("img", { name: "Cynthia Chen" })).toHaveCount(3);
  await expect(page.getByRole("img", { name: "Morgan Martin" })).toHaveCount(5);
});

test("a small pane drag settles on release and Escape", async ({ page }) => {
  await page.goto(`${viewer}#/design/components/swap-workspace`);
  const playground = page.getByRole("region", { name: "3 panels playground" });
  const pane = playground.locator('[data-group="One"]');
  const header = pane.locator(".multi-swap-header");

  const dragWithinPane = async (cancel: boolean) => {
    const startTransform = await pane.evaluate(
      (element) => element.style.transform,
    );
    const box = await header.boundingBox();
    if (!box) throw new Error("Missing pane header geometry");
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width, box.y + box.height / 2 + 20);
    if (cancel) await page.keyboard.press("Escape");
    else await page.mouse.up();
    await expect
      .poll(() => pane.evaluate((element) => element.style.transform))
      .toBe(startTransform);
    if (cancel) await page.mouse.up();
  };

  await dragWithinPane(false);
  await dragWithinPane(true);
});

test("a stale or renamed link explains itself instead of rendering blank", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  for (const hash of [
    "#/design/components/renamed-away",
    "#/design/colours",
    "#/design/nope/deeper",
  ]) {
    await page.goto(`${viewer}${hash}`);
    await expect(
      page.getByRole("heading", { name: "Not in the system" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Design system" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Go to the overview" }).click();
    await expect(
      page.getByRole("heading", { name: "Buzz Design System", exact: true }),
    ).toBeVisible();
  }
  expect(failures).toEqual([]);
});

test("component adoption uses real controls with labels and focusable busy switches", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/component-adoption`);
  const after = (name: string) =>
    page.getByRole("group", { name: `After: ${name}`, exact: true });
  const notification = after("Notification switch");
  const alerts = notification.getByRole("switch", { name: "Desktop alerts" });
  await expect(alerts).toBeChecked();
  await notification.locator("label").click();
  await expect(alerts).not.toBeChecked();
  await alerts.focus();
  await page.keyboard.press("Space");
  await expect(alerts).toBeChecked();
  const busy = after("Plugin switch").getByRole("switch", {
    name: "Enable busy plugin",
  });
  await busy.focus();
  await expect(busy).toBeFocused();
  await page.keyboard.press("Space");
  await expect(busy).toBeChecked();
  await expect(busy).toBeFocused();
  const toggle = after("Plugin switch").getByRole("switch", {
    name: "Enable example plugin",
  });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await after("Action buttons")
    .getByRole("button", { name: "Save profile" })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Action received. No app data was changed.",
  );
  await expect(
    after("Action buttons").getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  for (const mode of ["light", "dark"]) {
    const change = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await change.count()) await change.click();
    await expect(
      after("Shell actions").getByRole("button", { name: "Go back" }),
    ).toHaveCSS("width", "36px");
    await expect(
      after("Mention avatars").getByRole("img", {
        name: "Alex Lee",
        exact: true,
      }),
    ).toHaveCSS("width", "24px");
    const avatars = after("Mention avatars");
    for (const name of ["Brain", "Brain, small size"]) {
      await expect(avatars.getByRole("img", { name, exact: true })).toHaveCSS(
        "border-radius",
        "10px",
      );
    }
    const human = avatars.getByRole("img", { name: "Alex Lee", exact: true });
    expect(
      await human.evaluate(
        (element) =>
          parseFloat(getComputedStyle(element).borderTopLeftRadius) >=
          element.clientWidth / 2,
      ),
    ).toBe(true);
    await expect(after("Message avatars").getByRole("button")).toHaveCSS(
      "width",
      "40px",
    );
  }
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(
    page.getByRole("region", { name: "Component comparison" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
