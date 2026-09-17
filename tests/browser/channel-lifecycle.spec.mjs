import { test, expect } from "./fixture.mjs";
async function openLifecycle(page, app) {
  await page.goto(app.origin);
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
}

test.use({
  productionBroker: true,
  channelLifecycle: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Native modal focus/escape and real menu -> modal handoff require a browser.
// Role/type/signing/cancellation matrices remain in domain and mounted tests.
test("archive confirmation returns focus on cancel and navigates after confirmed removal", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await openLifecycle(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.getByRole("button", {
    name: "Lifecycle channel",
    exact: true,
  });
  await row.click();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toBeVisible();
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", {
    name: "Actions for Lifecycle channel",
  });
  await expect(
    menu.getByRole("menuitem", { name: "Archive channel…" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Leave channel…" }),
  ).toHaveAttribute("aria-disabled", "true");
  await menu.screenshot({ path: testInfo.outputPath("lifecycle-menu.png") });
  await menu.getByRole("menuitem", { name: "Archive channel…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Archive channel: Lifecycle channel",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.screenshot({
    path: testInfo.outputPath("lifecycle-confirmation.png"),
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(app.report.lifecyclePublications ?? []).toHaveLength(0);
  await row.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Archive channel…" }).click();
  await dialog
    .getByRole("button", { name: "Archive channel", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  expect(app.report.lifecyclePublications).toHaveLength(1);
  expect(app.report.lifecyclePublications[0].kind).toBe(9002);
  expect(app.report.unexpected).toEqual([]);
});

// The production page must project the separate per-viewer visibility snapshot
// after remount/reload, while membership/authorized channel reads remain intact.
test("DM hide is per-viewer visibility, survives reload and never sends Leave or Delete", async ({
  page,
  app,
}) => {
  await openLifecycle(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.locator(
    '[data-channel-id="22222222-2222-4222-8222-222222222222"]',
  );
  await expect(row).toBeVisible();
  await row.click();
  const composer = page.getByRole("textbox", { name: /^Message #/ });
  await expect(composer).toBeVisible();
  const composerName = await composer.getAttribute("aria-label");
  const conversationUrl = page.url();
  await row.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Hide conversation…" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Delete channel…" }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Leave channel…" }),
  ).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Hide conversation…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Hide conversation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(
    sidebar.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeVisible();
  // Wait for the actual visibility read to complete before asserting absence.
  await expect
    .poll(
      () =>
        app.report.queries.filter((query) =>
          JSON.stringify(query).includes("30622"),
        ).length,
    )
    .toBeGreaterThan(1);
  await expect(row).toHaveCount(0);
  // A hidden row is not an access denial. Exact navigation still opens its messages.
  await page.goto(conversationUrl);
  await expect(
    page.getByRole("textbox", { name: composerName, exact: true }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual([
    41012,
  ]);
  expect(app.report.unexpected).toEqual([]);
});

// Delete takes the access-purge route (archive does not), across the real broker,
// session, native dialog and navigation. Role permutations remain below the browser.
test("typed delete confirmation purges the selected channel and survives reload", async ({
  page,
  app,
}) => {
  await openLifecycle(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const row = sidebar.getByRole("button", {
    name: "Lifecycle channel",
    exact: true,
  });
  await row.click();
  await expect(
    page.getByRole("textbox", {
      name: "Message #Lifecycle channel",
      exact: true,
    }),
  ).toBeVisible();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete channel…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Delete channel: Lifecycle channel",
  });
  const confirm = dialog.getByRole("button", {
    name: "Delete channel",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "Channel name confirmation" })
    .fill("wrong name");
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "Channel name confirmation" })
    .fill("Lifecycle channel");
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(app.report.lifecyclePublications.map((event) => event.kind)).toEqual([
    9008,
  ]);
  expect(app.report.unexpected).toEqual([]);
});
