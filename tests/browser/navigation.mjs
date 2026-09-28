import { expect } from "@playwright/test";

export async function pageChoices(page) {
  await page.getByRole("button", { name: "Search Buzz", exact: true }).click();
  return page
    .getByRole("dialog", { name: "Search Buzz", exact: true })
    .getByRole("group", { name: "Actions", exact: true });
}

export async function openPage(page, name) {
  // The community rail appears after local startup has replaced the launch view.
  await expect(
    page.getByRole("button", { name: "Switch to Primary", exact: true }),
  ).toBeVisible();
  const choices = await pageChoices(page);
  const dialog = page.getByRole("dialog", { name: "Search Buzz", exact: true });
  const choice = choices.getByRole("option", { name, exact: true });
  // Registered page actions are visible only after the plugin catalog is ready.
  await expect(choice).toBeVisible();
  // The list enters with a delayed transform. Its moving hit targets can miss
  // a click in WebKit even after the option first becomes visible.
  await expect
    .poll(
      () =>
        dialog
          .locator(".search-palette-scroll")
          .evaluate((element) =>
            element
              .getAnimations()
              .every((animation) => animation.playState === "finished"),
          ),
      { message: "search choices finish opening" },
    )
    .toBe(true);
  await choice.click();
  await expect(dialog).not.toBeVisible();
}
