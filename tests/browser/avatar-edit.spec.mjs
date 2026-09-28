import { test, expect } from "./source-fixture.mjs";
import { readFile } from "node:fs/promises";
import { watchPageErrors } from "./page-errors.mjs";

// Browser boundary: nested overlay hit-testing/focus, canvas image preparation,
// lazy shadow-DOM emoji picker, and narrow viewport geometry in both engines.
test("shared human and agent avatar upload, scoped save, publication retry and nested popup", async ({
  page,
}) => {
  const artwork = await readFile(
    new URL("../fixtures/design-system/assets/avatar.png", import.meta.url),
  );
  const errors = watchPageErrors(page);
  await page.route("**/api/relay/**", (route) => route.abort());
  await page.goto("/tests/fixtures/agent-control.html?avatars");
  await page
    .getByRole("button", { name: "Edit human profile", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Profile to edit", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Fixture human",
  );

  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByLabel("Upload an image", { exact: true }).setInputFiles({
    name: "test.png",
    mimeType: "image/png",
    buffer: artwork,
  });
  await expect(page.getByLabel("Picture URL (optional)")).toHaveValue(
    /https:\/\/relay.example.test\/media\//,
  );
  await expect(
    page
      .getByRole("img", { name: "Avatar preview", exact: true })
      .locator("img"),
  ).toHaveAttribute("data-loaded", "true");
  await page.screenshot({ path: test.info().outputPath("human-avatar.png") });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Profile updated", { exact: true }).waitFor();
  const human = await page.evaluate(() => ({
    saved: JSON.parse(
      window.avatarProfileFixture.profiles.get("https://relay.example.test")
        .content,
    ),
    other: JSON.parse(
      window.avatarProfileFixture.profiles.get("https://other.example.test")
        .content,
    ),
    local: window.avatarProfileFixture.communities.snapshot().profile,
  }));
  expect(human.saved).toMatchObject({
    name: "Fixture human",
    about: "This field must survive avatar editing.",
    picture: expect.stringMatching(/^https:\/\/relay.example.test\/media\//),
  });
  expect(human.other.picture).toBe("");
  expect(human.local).toMatchObject({
    name: human.saved.name,
    // Private community artwork must not become the seed for another community.
    picture: "",
    about: human.saved.about,
  });
  // No live kind-0 transport in this fixture: confirmation must refresh the
  // captured session directory, not depend on an eventual WebSocket echo.
  await expect(
    page
      .getByRole("button", { name: "Your profile", exact: true })
      .locator("img"),
  ).toHaveAttribute("data-loaded", "true");
  await page.getByRole("button", { name: "Edit agents", exact: true }).click();
  await page
    .getByRole("button", { name: "Reject publication", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Actions for Fixture agent", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await page.getByLabel("Emoji", { exact: true }).fill("🧠");
  await page.getByLabel("Background color", { exact: true }).fill("#FFF4CC");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByText(
      "Settings saved; profile publication is unconfirmed. Refresh status, then retry publication below or on the agent card.",
      { exact: true },
    )
    .waitFor();
  await expect
    .poll(() =>
      page.evaluate(() => window.agentControlFixture.agent.profilePending),
    )
    .toBe(true);
  await page.evaluate(() => window.agentControlFixture.failProfile(false));
  await page
    .getByRole("button", { name: "Retry profile publication", exact: true })
    .click();
  await page
    .getByText("Profile published. Running work was not restarted.", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await expect(
    page
      .getByRole("img", { name: "Avatar preview", exact: true })
      .locator("img"),
  ).toHaveAttribute("data-loaded", "true");
  await page.screenshot({ path: test.info().outputPath("agent-avatar.png") });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Edit avatar", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () => (document.documentElement.dataset.colorMode = "dark"),
  );
  await page.getByRole("button", { name: "Edit avatar", exact: true }).click();
  await page.getByRole("tab", { name: "Emoji", exact: true }).click();
  await page.locator("em-emoji-picker").waitFor();
  await page
    .getByRole("button", { name: "Done", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeInViewport();
  const bounds = await page
    .locator("[data-buzz-ui].popover-surface")
    .boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);

  await page.screenshot({
    path: test.info().outputPath("agent-avatar-narrow.png"),
  });
  const result = await page.evaluate(() => ({
    agent: window.agentControlFixture.agent,
    actions: window.agentControlFixture.calls.filter(
      (c) => c.action !== "snapshot",
    ),
  }));
  expect(result.agent).toMatchObject({
    picture: expect.stringMatching(/^https:\/\/relay.example.test\/media\//),
    profilePending: false,
    revision: 2,
    runningRevision: 1,
  });
  expect(result.actions.map((c) => c.action)).toEqual([
    "save",
    "profile",
    "profile",
  ]);
  expect(result.actions[0].payload.edit.picture).toBe(result.agent.picture);
  expect(errors.unexplained()).toEqual([]);
});
