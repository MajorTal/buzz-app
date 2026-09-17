import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only boundary: real shared-menu focus/dismissal, production broker,
// IndexedDB reload and app-global preference startup. Policy matrices live in Vitest.
test.use({
  productionBroker: true,
  readState: true,
  savedSidebar: true,
  historyCounts: { alpha: 8, beta: 6 },
});

test("channel menu mute/read persist without selecting the row; failed mute remains retryable", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-appearance.v1", "dark"),
  );
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const beta = sidebar.locator('[data-channel-id="beta"]');
  const alpha = sidebar.locator('[data-channel-id="alpha"]');
  const menu = page.getByRole("menu", { name: "Actions for Beta" });
  const badge = (row) =>
    row.getByRole("img", { name: /observed unread messages/ });
  await expect(badge(beta)).toHaveAttribute(
    "aria-label",
    /^6 observed unread messages/,
  );
  await expect(badge(alpha)).toHaveAttribute(
    "aria-label",
    /^8 observed unread messages/,
  );
  await beta.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.screenshot({ path: testInfo.outputPath("mute-read-menu.png") });
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    started = resolve;
  });
  await page.route("**/sidebar-mute", async (route) => {
    started();
    await gate;
    app.report.sidebarMuteFailures ??= [];
    app.report.sidebarMuteFailures.push(route.request().url());
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Fixture mute failure" }),
    });
  });
  try {
    await menu.getByRole("menuitem", { name: "Mute", exact: true }).click();
    await requested;
    await expect(menu.getByRole("status")).toHaveText("Saving…");
    await expect(
      menu.getByRole("menuitem", { name: "Mark as Read" }),
    ).toBeDisabled();
    await expect(beta.getByLabel("Muted; mentions still notify")).toHaveCount(
      0,
    );
  } finally {
    release();
  }
  await expect(menu.getByRole("alert")).toHaveText(
    "Relay request failed (502)",
  );
  await page.unroute("**/sidebar-mute");
  await menu.getByRole("menuitem", { name: "Mute", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  await expect(beta.getByLabel("Muted; mentions still notify")).toBeVisible();
  await expect(badge(beta)).toHaveAttribute(
    "aria-label",
    /^6 observed unread messages/,
  );
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-mutes",
    blob: { channels: { beta: { muted: true } } },
  });
  await page.keyboard.press("ContextMenu");
  await expect(
    menu.getByRole("menuitem", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await menu.getByRole("menuitem", { name: "Mark as Read" }).click();
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  await expect(badge(beta)).toHaveCount(0);
  await expect(badge(alpha)).toHaveAttribute(
    "aria-label",
    /^8 observed unread messages/,
  );
  await expect(alpha).toHaveAttribute("aria-current", "page");
  await expect
    .poll(
      () =>
        app.report.readPublications.some(
          ({ blob }) =>
            blob.contexts.beta ===
            app.histories.get("primary/beta").at(-1).created_at,
        ),
      { timeout: 12000 },
    )
    .toBe(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await expect(beta.getByLabel("Muted; mentions still notify")).toBeVisible();
  await expect(badge(alpha)).toHaveAttribute(
    "aria-label",
    /^8 observed unread messages/,
  );
  await expect(badge(beta)).toHaveCount(0);
  await beta.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Unmute", exact: true }).click();
  // A modal menu temporarily hides its background from accessible queries.
  // Dismissal establishes confirmed completion, not the icon's hidden interval.
  await expect(menu).toHaveCount(0);
  await expect(beta).toBeFocused();
  await expect(beta.getByLabel("Muted; mentions still notify")).toHaveCount(0);
  expect(app.report.sidebarPublications.at(-1)).toMatchObject({
    coordinate: "channel-mutes",
    blob: { channels: { beta: { muted: false } } },
  });
  expect(app.report.unexpected).toEqual([]);
});
