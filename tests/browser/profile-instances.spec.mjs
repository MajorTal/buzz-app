import { test, expect } from "./source-fixture.mjs";

// Real host replacement and keyboard close/focus need a browser; permission and
// exact-selection matrices remain in colocated React/helper tests.
for (const archived of [false, true]) {
  test(`instance profile keeps exact selection through tab selection and close (archived=${archived})`, async ({
    page,
  }) => {
    await page.goto(
      `/tests/fixtures/profiles.html?agent-instances${archived ? "&archived" : ""}`,
    );
    const thread = page.getByRole("button", {
      name: "View thread: 1 reply",
      exact: true,
    });
    await thread.click();
    await page
      .getByRole("button", { name: "View Pinky profile", exact: true })
      .click();
    const panel = page.getByRole("complementary", {
      name: "Profile",
      exact: true,
    });
    await panel.getByRole("tab", { name: "Runtime", exact: true }).click();
    await panel.getByText("2 instances").click();
    await panel
      .getByRole("button", { name: "Second instance", exact: true })
      .click();
    await expect(
      panel.getByText("/fixture/second", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText("/fixture/first", { exact: true }),
    ).toHaveCount(0);
    await panel.getByRole("tab", { name: "Runtime", exact: true }).click();
    await panel.getByText("2 instances").click();
    await expect(
      panel.getByRole("button", { name: "Second instance", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    if (archived)
      await expect(
        panel.getByRole("region", { name: "Instances" }),
      ).toContainText("Archived");
    await panel.getByRole("tab", { name: "Channels", exact: true }).click();
    await panel.getByRole("tab", { name: "Info", exact: true }).click();
    await expect(
      panel.getByText("/fixture/second", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close Pinky · Instance tab", exact: true })
      .click();
    await expect(
      panel.getByRole("region", { name: "Local agent", exact: true }),
    ).toHaveCount(0);
    // Returning to the retained profile preserves its open Runtime disclosure.
    await expect(
      panel.getByRole("tab", { name: "Runtime", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await panel
      .getByRole("button", { name: "First instance", exact: true })
      .click();
    await expect(
      panel.getByText("/fixture/first", { exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("region", { name: "Profile details" })
      .press("Escape");
    await expect(
      page.getByRole("tab", { name: "Pinky", exact: true }),
    ).toBeFocused();
    await expect(
      panel.getByRole("region", { name: "Local agent", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close Pinky tab", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "Thread", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Close Thread tab", exact: true })
      .click();
    await expect(panel).toBeHidden();
    await expect(thread).toBeFocused();
    await thread.click();
    await page
      .getByRole("button", { name: "View Pinky profile", exact: true })
      .click();
    await panel.getByRole("tab", { name: "Runtime", exact: true }).click();
    await panel.getByText("2 instances").click();
    await panel
      .getByRole("button", { name: "Second instance", exact: true })
      .click();
    await expect(
      panel.getByText("/fixture/second", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.profilesFixture.deleteSecond());
    await expect(panel.getByRole("alert")).toHaveText("Unavailable");
    await expect(
      panel.getByText("/fixture/first", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close Profile tab", exact: true })
      .click();
    await expect(
      panel.getByRole("heading", { name: "Pinky", exact: true }),
    ).toBeVisible();
  });
}
