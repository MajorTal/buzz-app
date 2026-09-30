import { test, expect } from "./source-fixture.mjs";
import { settle } from "./timeline.mjs";

// Real paint order and clipping cannot be established by DOM component tests.
test("reaction previews paint above floating message actions", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap&narrow");
  const row = page.locator("[data-message-id]").first();
  const reaction = row.locator('button[data-reaction="👍"]');
  await reaction.hover();
  const preview = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  await expect(preview).toBeVisible();
  const actions = row.getByRole("group", { name: "Message actions" });
  await expect
    .poll(() => actions.evaluate((el) => el.matches(":popover-open")))
    .toBe(true);
  // Force the real toolbar into the preview's footprint to probe paint order
  // independently of content length and font geometry. Keep its top-layer order.
  await actions.evaluate((bar) => {
    const card = document.querySelector(".buzz-preview-card[data-open]");
    const rect = card.getBoundingClientRect();
    bar.style.top = `${rect.top}px`;
    bar.style.left = `${rect.left}px`;
    bar.style.right = "auto";
  });
  await expect
    .poll(() =>
      preview.evaluate((card) => {
        const rect = card.getBoundingClientRect();
        // Supplemental cards ignore pointer input. Temporarily enable it solely
        // for this paint probe, restoring the real interaction policy afterwards.
        card.style.pointerEvents = "auto";
        const hit = document.elementFromPoint(rect.left + 10, rect.top + 10);
        card.style.pointerEvents = "";
        return card === hit || card.contains(hit);
      }),
    )
    .toBe(true);
  await page.mouse.move(0, 0);
  await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
  await reaction.hover();
  await expect(preview).toBeVisible();
});

test("video speed options escape the thread and restore focus after selection and Escape", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?thread");
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.colorMode = "light";
  });
  const trigger = page
    .getByRole("button", { name: "Playback speed: 1x" })
    .first();
  await expect(trigger).toBeVisible();
  // Put the speed control just below the scroller's top edge: the old inline
  // fieldset loses its upper options behind that boundary.
  await trigger.evaluate((button) => {
    const scroller = button.closest("[data-message-scroller]");
    scroller.scrollTop +=
      button.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      40;
  });
  await page.locator("[data-video-preview]").first().hover();
  await trigger.click();
  const menu = page.getByRole("menu", { name: /^Playback speed:/ });
  await expect(menu).toBeVisible();
  // The scoped dark owner must keep the explicit floating recipe, not the
  // ordinary dark control fill (#333333), even though the host stays light.
  await expect(menu).toHaveCSS("--interaction-fill", "#404040");
  await expect(menu).toHaveCSS("background-color", "rgb(51, 51, 51)");
  const fast = menu.getByRole("menuitemradio", { name: "2x", exact: true });
  await expect
    .poll(() =>
      fast.evaluate((item) => {
        const rect = item.getBoundingClientRect();
        const edge = document
          .querySelector("[data-message-scroller]")
          .getBoundingClientRect().top;
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return rect.top < edge && (item === hit || item.contains(hit));
      }),
    )
    .toBe(true);
  await fast.click();
  await expect(menu).toBeHidden();
  const updated = page
    .getByRole("button", { name: "Playback speed: 2x" })
    .first();
  await expect(updated).toBeFocused();
  await expect(page.locator("video").first()).toHaveJSProperty(
    "playbackRate",
    2,
  );
  await updated.press("Enter");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(updated).toBeFocused();
  await updated.click();
  await page.getByRole("heading", { name: "Video and photo review" }).click();
  await expect(menu).toBeHidden();
  await page.locator("[data-video-preview]").first().hover();
  await page
    .getByRole("button", { name: "Open video fullscreen" })
    .first()
    .click();
  const review = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  const reviewSpeed = review.getByRole("button", {
    name: "Playback speed: 2x",
  });
  await reviewSpeed.focus();
  await reviewSpeed.press("Enter");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("--interaction-fill", "#404040");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toHaveCSS("background-color", "rgb(64, 64, 64)");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    menu.getByRole("menuitemradio", { name: "2x", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitemradio", { name: "1.75x", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  const selected = review.getByRole("button", {
    name: "Playback speed: 1.75x",
  });
  await expect(selected).toBeFocused();
  await selected.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(review).toBeVisible();
  await expect(selected).toBeFocused();
});

// Retry is a Button under the viewer's unavailable-media branch, not its header.
test("unavailable dark media review keeps Retry readable in a light host", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?photo&missing-root");
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.colorMode = "light";
  });
  const dialog = page.getByRole("dialog", { name: "Image viewer" });
  const retry = dialog.getByRole("button", { name: "Retry", exact: true });
  await expect(dialog.getByRole("alert").first()).toContainText(
    "Original message unavailable.",
  );
  await expect(retry).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(retry).toHaveCSS("background-color", "rgb(51, 51, 51)");
  await retry.hover();
  await expect(retry).toHaveCSS("background-color", "rgb(64, 64, 64)");
});

// Shared preview callers must retain viewport placement and non-stealing focus.
test("resolved chip previews fit narrow, intermediate and wide themed views", async ({
  page,
}) => {
  await page.goto(
    "/tests/fixtures/design-system.html#/design/components/inline-chip",
  );
  const chip = page
    .locator('button.inline-chip[data-state="resolved"]')
    .first();
  for (const [width, mode] of [
    [390, "light"],
    [900, "dark"],
    [1440, "light"],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate((mode) => {
      document.documentElement.classList.toggle("dark", mode === "dark");
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await chip.scrollIntoViewIfNeeded();
    await chip.focus();
    await chip.hover();
    const preview = page.locator(
      '.buzz-preview-card[role="tooltip"][data-open]',
    );
    await expect(preview).toBeVisible();
    await expect(chip).toBeFocused();
    await expect
      .poll(() =>
        preview.evaluate((card) => {
          const rect = card.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    await page.mouse.move(0, 0);
    await chip.blur();
    await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
  }
});

// Browser-only: sibling reflow moves the anchor without resizing the observed
// row/slot/scroller. jsdom cannot establish this geometry or native focus.
test("focused actions follow sibling growth and shrinkage without scrolling", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html");
  const rows = page.locator("[data-message-id]");
  const sibling = rows.nth(0);
  const row = rows.nth(1);
  await expect(row).toBeVisible();
  // Bound the real message list without introducing app traffic that could
  // accidentally rescue stale positioning through unrelated DOM mutations.
  await row.evaluate((node) => {
    const list = node.parentElement;
    list.setAttribute("data-message-scroller", "");
    list.style.height = "600px";
    list.style.overflow = "auto";
  });
  const scroller = page.locator("[data-message-scroller]");
  const actions = row.getByRole("group", {
    name: "Message actions",
    includeHidden: true,
  });
  await row.hover();
  await expect
    .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
    .toBe(true);
  const button = actions.getByRole("button").first();
  await button.focus();
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await settle(page, scroller);
  const baseline = await actions.evaluate((bar) => {
    const slot = bar.parentElement;
    const scroller = bar.closest("[data-message-scroller]");
    return {
      top: slot.getBoundingClientRect().top,
      slotHeight: slot.offsetHeight,
      rowHeight: bar.closest("[data-layout]").offsetHeight,
      scrollerHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
    };
  });
  const scrolls = await scroller.evaluateHandle((node) => {
    const state = { count: 0 };
    const listener = () => state.count++;
    node.addEventListener("scroll", listener);
    return {
      state,
      dispose: () => node.removeEventListener("scroll", listener),
    };
  });
  try {
    for (const growth of [100, 0]) {
      // Models an attachment or edit changing only the preceding message's height.
      await sibling.evaluate((node, growth) => {
        node.style.paddingBottom = `${growth}px`;
      }, growth);
      await expect
        .poll(() =>
          actions.evaluate((bar) => ({
            slotTop: bar.parentElement.getBoundingClientRect().top,
            barBottom: bar.getBoundingClientRect().bottom,
          })),
        )
        .toEqual({
          slotTop: baseline.top + growth,
          barBottom: baseline.top + growth,
        });
      await expect(button).toBeFocused();
      await expect
        .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
        .toBe(true);
      // Complete layout and scroll-event delivery before the negative assertions.
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
      expect(
        await actions.evaluate((bar) => ({
          slotHeight: bar.parentElement.offsetHeight,
          rowHeight: bar.closest("[data-layout]").offsetHeight,
          scrollerHeight: bar.closest("[data-message-scroller]").clientHeight,
          scrollTop: bar.closest("[data-message-scroller]").scrollTop,
        })),
      ).toEqual({
        slotHeight: baseline.slotHeight,
        rowHeight: baseline.rowHeight,
        scrollerHeight: baseline.scrollerHeight,
        scrollTop: baseline.scrollTop,
      });
      expect(await scrolls.evaluate(({ state }) => state.count)).toBe(0);
    }
  } finally {
    await scrolls.evaluate(({ dispose }) => dispose());
    await scrolls.dispose();
  }
});

// Top-layer previews ignore z-index, so only the browser can show a background
// destination staying clickable above a modal opened while it was hovered.
test("destination previews yield to modals they are outside", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/tests/fixtures/preview-modal.html");
  const preview = (name) =>
    page.getByRole("link", { name: `${name} preview`, exact: true });
  const clickable = (card) =>
    card.evaluate((card) => {
      const rect = card.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + 10, rect.top + 10);
      return card === hit || card.contains(hit);
    });
  const background = preview("Background");
  await page.getByRole("link", { name: "Open Background" }).hover();
  await expect(background).toBeVisible();
  const bounds = await background.boundingBox();
  await page.mouse.move(bounds.x + 10, bounds.y + 10);
  await expect.poll(() => clickable(background)).toBe(true);

  await page.getByRole("button", { name: "Open modal" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Modal" });
  await expect(dialog).toBeVisible();
  // Outlast the close delay with the pointer still over the preview.
  await page.clock.runFor(1000);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector(".buzz-preview-card[data-open]")
            ?.parentElement?.matches(":popover-open") ?? false,
      ),
    )
    .toBe(false);
  // The backdrop, not the background preview, receives the click.
  await page.mouse.click(bounds.x + 10, bounds.y + 10);
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.previewClicks)).toEqual([]);

  // A trigger inside the active modal keeps its preview above the backdrop.
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "Open modal" }).click();
  await dialog.getByRole("link", { name: "Open Inside" }).hover();
  const inside = preview("Inside");
  await expect(inside).toBeVisible();
  await expect.poll(() => clickable(inside)).toBe(true);
  await inside.click();
  expect(await page.evaluate(() => window.previewClicks)).toEqual(["Inside"]);

  // Once dismissed, background previews rejoin the top layer.
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("link", { name: "Open Background" }).hover();
  await expect(background).toBeVisible();
  await expect.poll(() => clickable(background)).toBe(true);
});
