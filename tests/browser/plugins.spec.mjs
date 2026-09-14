import { test, expect } from "./fixture.mjs";

test.use({ pluginFixtures: true, historyCounts: { alpha: 0, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const card = (page, name) =>
  page.getByRole("complementary", { name, exact: true });

test("a second plugin uses the same launcher slot without remounting a legacy page or accepting stale handlers", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Legacy" })
    .click();
  const draft = page.getByRole("textbox", { name: "Legacy page draft" });
  await draft.fill("Keep the page instance");
  await button(page, "Notes").click();
  await expect(card(page, "Notes")).toHaveCount(1);
  await expect(card(page, "Wrong panel")).toHaveCount(0);
  await expect(card(page, "Notes")).toContainText("not-an-agent-api");
  await expect(draft).toHaveValue("Keep the page instance");
  const note = page.getByRole("textbox", { name: "Panel note" });
  await note.fill("Close this opening");
  await button(page, "Notes").click();
  await expect(card(page, "Notes")).toHaveCount(0);
  await expect(button(page, "Notes")).toBeFocused();
  await expect(draft).toHaveValue("Keep the page instance");
  await button(page, "Notes").click();
  await expect(note).toHaveValue("");
  await button(page, "Bestie").click();
  await expect(card(page, "Notes")).toHaveCount(0);
  await expect(card(page, "Bestie")).toHaveCount(1);
  await page.evaluate(() => window.stalePanelClose());
  await expect(card(page, "Bestie")).toHaveCount(1);
  await button(page, "Close Bestie panel").click();
  await expect(draft).toHaveValue("Keep the page instance");
  await button(page, "Notes").click();
  await button(page, "Your profile").click();
  await button(page, "Settings").click();
  await button(page, "Plugins").click();
  await page.getByRole("switch", { name: "Enable Notes fixture" }).click();
  await expect(button(page, "Notes")).toHaveCount(0);
  await expect(card(page, "Notes")).toHaveCount(0);
  await page.getByRole("switch", { name: "Enable Notes fixture" }).click();
  await expect(button(page, "Notes")).toBeVisible();
  await expect(card(page, "Notes")).toHaveCount(0);
  await button(page, "Bestie").click();
  await page.evaluate(() => window.stalePanelClose());
  await expect(card(page, "Bestie")).toHaveCount(1);
});

test("the launched card works with an empty Channels roster", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (filters.some((filter) => filter.kinds?.includes(39002)))
      return route.fulfill({ json: [] });
    return route.continue();
  });
  await page.goto(app.origin);
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Messages" })
    .click();
  await expect(
    page.getByText("No channels yet.", { exact: true }),
  ).toBeVisible();
  await button(page, "Bestie").click();
  await expect(card(page, "Bestie")).toHaveCount(1);
  await button(page, "Notes").click();
  await expect(card(page, "Notes")).toHaveCount(1);
  await expect(card(page, "Bestie")).toHaveCount(0);
  await button(page, "Close Notes panel").click();
  await expect(card(page, "Notes")).toHaveCount(0);
  await expect(button(page, "Notes")).toBeFocused();
});

// Independent reviewer controls: Brain.
test("old close cannot dismiss a later opening of the same contribution", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Notes").click();
  await expect(card(page, "Notes")).toHaveCount(1);
  await page.evaluate(() => {
    window.firstNotesClose = window.stalePanelClose;
  });
  await button(page, "Bestie").click();
  await expect(card(page, "Notes")).toHaveCount(0);
  await button(page, "Notes").click();
  await page.getByRole("textbox", { name: "Panel note" }).fill("A new opening");
  await page.evaluate(() => window.firstNotesClose());
  await expect(card(page, "Notes")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Panel note" })).toHaveValue(
    "A new opening",
  );
});

test("companion remains usable while Channels connection is pending", async ({
  page,
  app,
}) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/primary/session", async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto(app.origin);
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Messages" })
      .click();
    await expect(
      page.getByText("Connecting to your relay…", { exact: true }),
    ).toBeVisible();
    await button(page, "Notes").click();
    await expect(card(page, "Notes")).toHaveCount(1);
    await button(page, "Close Notes panel").click();
    await expect(button(page, "Notes")).toBeFocused();
    await button(page, "Bestie").click();
    release();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await expect(card(page, "Bestie")).toHaveCount(1);
  } finally {
    release();
  }
});
