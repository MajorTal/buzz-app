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
  await page.goto(`${viewer}#/design/maintaining`);
  await expect(
    page.getByRole("heading", { name: "Design rationale", exact: true }),
  ).toBeVisible();
  await nav.getByRole("link", { name: "AGENTS.md", exact: true }).click();
  await expect(page.locator("main")).toContainText(
    "No local light/dark color overrides",
  );
  await expect(page.locator("main")).toContainText(
    "same palette step in both modes",
  );
  expect(failures).toEqual([]);
  expect(sockets).toEqual([]);
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
  await expect(page.getByRole("img", { name: "Morgan Martin" })).toHaveCount(4);
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
