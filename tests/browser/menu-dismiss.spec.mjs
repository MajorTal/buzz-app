import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only boundary: Base UI restores focus when a popup's exit
// transition ends. The test holds that transition, so the user's next focus
// move lands while the old menu is still closing.
async function holdMenuExit(page) {
  await page.evaluate(() => {
    document.addEventListener(
      "transitionrun",
      (event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.matches(".buzz-menu-popup[data-ending-style]")
        )
          for (const animation of event.target.getAnimations())
            animation.pause();
      },
      true,
    );
  });
  return {
    // Closing has started and cannot finish until release().
    held: (popup) =>
      expect
        .poll(() =>
          popup.evaluate((element) =>
            element.getAnimations().some((a) => a.playState === "paused"),
          ),
        )
        .toBe(true),
    release: () =>
      page.evaluate(() => {
        for (const animation of document.getAnimations())
          if (animation.playState === "paused") animation.finish();
      }),
  };
}

// The entrance has started and settled. Animations alone are not enough: an
// Escape before the entrance transition starts closes without any transition.
async function opened(popup) {
  await expect(popup).toHaveAttribute("data-open", "");
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await expect
    .poll(() => popup.evaluate((element) => element.getAnimations().length))
    .toBe(0);
}

test("closing a menu keeps focus where the user moved it", async ({
  page,
  app,
}) => {
  await open(page, app);
  const exit = await holdMenuExit(page);
  const row = page
    .getByRole("navigation", {
      name: "Subscribed channels",
      includeHidden: true,
    })
    .locator('[data-channel-id="beta"]');
  const rowMenu = page.getByRole("menu", { name: "Actions for Beta" });
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });

  try {
    await row.click({ button: "right" });
    await opened(rowMenu);
    await page.keyboard.press("Escape");
    await exit.held(rowMenu);
    await composer.click();
    await expect(composer).toBeFocused();
    await expect(rowMenu).toHaveCount(1);
    await exit.release();
    // The row menu has finished closing. Its explicit final focus (the row)
    // must not pull focus back out of the composer.
    await expect(rowMenu).toHaveCount(0);
    await expect(composer).toBeFocused();

    // A collapsed disclosure (Base UI marks it data-closed, like a closing
    // popup) is ordinary page content. Focus moved into it also stays.
    await page.evaluate(() => {
      const collapsed = document.createElement("div");
      collapsed.setAttribute("data-closed", "");
      collapsed.innerHTML = '<button type="button">Collapsed control</button>';
      document.getElementById("main-content").append(collapsed);
    });
    const collapsedControl = page.getByRole("button", {
      name: "Collapsed control",
    });
    await row.click({ button: "right" });
    await opened(rowMenu);
    await page.keyboard.press("Escape");
    await exit.held(rowMenu);
    await collapsedControl.focus();
    await expect(rowMenu).toHaveCount(1);
    await exit.release();
    await expect(rowMenu).toHaveCount(0);
    await expect(collapsedControl).toBeFocused();

    // With nothing else focused, Escape still returns focus to the row.
    await row.click({ button: "right" });
    await opened(rowMenu);
    await page.keyboard.press("Escape");
    await exit.held(rowMenu);
    await exit.release();
    await expect(rowMenu).toHaveCount(0);
    await expect(row).toBeFocused();
  } finally {
    await exit.release();
  }
});
