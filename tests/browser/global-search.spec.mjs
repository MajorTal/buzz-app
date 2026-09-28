import { test, expect } from "./fixture.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
test.describe("photo avatar", () => {
  test.use({ profilePicture: "https://avatar.invalid/photo.svg" });

  // Browser layout and DOM focus across the portal cannot be proved in jsdom.
  test("top-bar search and avatar share a vertical center", async ({
    page,
    app,
  }) => {
    // A photo has different inline baseline behavior from the initial-letter fallback.
    await page.route("https://avatar.invalid/photo.svg", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="navy"/></svg>',
      }),
    );
    // Seed the signed community photo before startup; reloading can retire a stream while
    // its initial control request is still in flight.
    await page.goto(app.origin);
    await expect(button(page, "Your profile").locator("img")).toHaveAttribute(
      "data-loaded",
      "true",
    );
    const search = await button(page, "Search Buzz").boundingBox();
    const profile = await button(page, "Your profile").boundingBox();
    expect(search).not.toBeNull();
    expect(profile).not.toBeNull();
    expect(search.y + search.height / 2).toBeCloseTo(
      profile.y + profile.height / 2,
      1,
    );
  });
});

test("search arrows traverse the conversation action and recent activity, Enter opens and Escape restores focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const trigger = button(page, "Search Buzz");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  await expect(input).toHaveAttribute("spellcheck", "false");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("autocapitalize", "off");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toBeFocused();
  const first = dialog
    .getByRole("group", { name: "This conversation" })
    .getByRole("option");
  const second = dialog
    .getByRole("group", { name: "Recent activity" })
    .getByRole("option")
    .first();
  await expect(second).toBeVisible();
  for (const [key, result] of [
    ["ArrowDown", first],
    ["ArrowDown", second],
    ["ArrowUp", first],
    ["ArrowUp", first],
  ]) {
    await input.press(key);
    await expect(input).toBeFocused();
    await expect(result).toHaveAttribute("aria-selected", "true");
    await expect(result).toHaveAttribute("data-selected", "true");
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      await result.getAttribute("id"),
    );
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+k`);
  await expect(input).toBeFocused();
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await input.fill("Alpha");
  const alpha = dialog
    .getByRole("group", { name: "Channels" })
    .getByRole("option", { name: /Alpha/ });
  await expect(alpha).toBeVisible();
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(input).toBeFocused();
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    await alpha.getAttribute("id"),
  );
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("changing search scope returns focus to the input without clearing the query", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Search Buzz").click();
  const scopeAction = page
    .getByRole("dialog", { name: "Search Buzz" })
    .getByRole("group", { name: "This conversation" })
    .getByRole("option");
  await scopeAction.click();

  const scoped = page.getByRole("dialog", { name: "Search this conversation" });
  const scopedInput = scoped.getByRole("combobox", {
    name: "Search this conversation",
  });
  await expect(scopedInput).toBeFocused();
  await page.keyboard.type("hello");
  await expect(scopedInput).toHaveValue("hello");

  const chip = scoped.getByRole("button", {
    name: /Remove .* search scope/,
  });
  await chip.focus();
  await chip.press("Enter");
  const global = page.getByRole("dialog", { name: "Search Buzz" });
  const input = global.getByRole("combobox", { name: "Search Buzz" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("hello");
  await page.keyboard.press("ArrowDown");
  await expect(
    global
      .getByRole("group", { name: "This conversation" })
      .getByRole("option"),
  ).toHaveAttribute("aria-selected", "true");
});

// Real portal → routed timeline/thread ownership and focus, in both browser engines.
test.describe("public search destination", () => {
  test.use({ openSearch: true, productionBroker: true });
  test("opens a public nonmember exact reply without enabling writes or adding a sidebar row", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await expect(button(page, "Search Buzz")).toBeVisible();
    for (const mode of ["cold", "warm"]) {
      await button(page, "Search Buzz").click();
      const input = page.getByRole("combobox", { name: "Search Buzz" });
      await input.fill("crew-search");
      const result = page.getByRole("option", {
        name: /crew-search exact public reply/,
      });
      await expect(result).toBeVisible();
      const start = performance.now();
      await result.click();
      const thread = page.getByRole("region", {
        name: "Thread messages",
        exact: true,
      });
      const row = thread.locator(`[data-message-id="${app.searchTarget.id}"]`);
      await expect(row).toBeVisible();
      await expect(row).toBeFocused();
      app.report.measurements.push({
        mode,
        clickToFocusedMs: performance.now() - start,
      });
      await expect(
        page.getByText(
          "Read-only preview · You haven’t joined this conversation.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message #open", exact: true }),
      ).toHaveAttribute("aria-disabled", "true");
      await expect(
        page.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toHaveAttribute("aria-disabled", "true");
      await expect(
        page
          .getByRole("complementary", { name: "Channel sidebar" })
          .getByRole("button", { name: "open", exact: true }),
      ).toHaveCount(0);
    }
    expect(
      app.report.queries
        .filter(({ filter }) => filter.search)
        .every(({ filter }) => !filter["#h"]),
    ).toBe(true);
  });
});
