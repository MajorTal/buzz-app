import { test, expect } from "./fixture.mjs";
import { open, settle, virtuaIdle, wheel } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 3, beta: 1 },
});

const actionsFor = (row) =>
  row.getByRole("group", { name: "Message actions", includeHidden: true });
const shown = (actions) =>
  expect
    .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
    .toBe(true);

// Browser-only: top-layer painting/hit testing across containment, real scrolling,
// and stable header geometry cannot be established in jsdom.
test("thread actions and growing reactions paint beyond the scroller without moving text", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  let last;
  for (let i = 0; i < 7; i++) {
    last = app.append(
      "primary",
      "alpha",
      `Floating reply ${i}\n\nSecond paragraph\n\nThird paragraph`,
      false,
      i === 6,
      root.id,
    );
  }
  await open(page, app);
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const scroller = panel.getByRole("region", { name: "Thread messages" });
  const row = panel.locator(`[data-message-id="${last.id}"]`);
  const actions = actionsFor(row);
  await expect(row).toBeVisible();
  await settle(page, scroller);
  // Leave the author line across the bottom edge, with the lifted toolbar
  // crossing it and the start of the message still reachable by pointer.
  await actions.evaluate((bar) => {
    const slot = bar.parentElement;
    const scroller = bar.closest("[data-message-scroller]");
    scroller.scrollTop +=
      slot.getBoundingClientRect().top -
      scroller.getBoundingClientRect().bottom +
      -14;
  });
  await settle(page, scroller);
  const restingHeight = (await row.boundingBox()).height;
  const bounds = await scroller.boundingBox();
  const rowBounds = await row.boundingBox();
  await page.mouse.move(rowBounds.x + 80, bounds.y + bounds.height - 2);
  await shown(actions);
  await expect
    .poll(() =>
      actions.evaluate((bar) => {
        const slot = bar.parentElement.getBoundingClientRect();
        const rect = bar.getBoundingClientRect();
        const edge = bar
          .closest("[data-message-scroller]")
          .getBoundingClientRect().bottom;
        const button = bar.querySelector("button").getBoundingClientRect();
        return {
          anchored: slot.height === 0 && Math.abs(slot.top - rect.bottom) < 1,
          crosses: rect.top < edge && rect.bottom > edge + 4,
          hit: bar.contains(
            document.elementFromPoint(button.x + button.width / 2, edge + 4),
          ),
        };
      }),
    )
    .toEqual({ anchored: true, crosses: true, hit: true });
  expect((await row.boundingBox()).height).toBe(restingHeight);
  // Moving onto the escaped controls must keep the row's reveal state alive.
  const quick = actions.getByRole("button", {
    name: "React with 👍",
    exact: true,
  });
  const quickBox = await quick.boundingBox();
  await page.mouse.move(
    quickBox.x + quickBox.width / 2,
    bounds.y + bounds.height + 4,
  );
  await shown(actions);
  const glyph = quick.locator('[class*="quickReactionGlyph"]');
  await expect
    .poll(() =>
      glyph.evaluate((node) => {
        const matrix = new DOMMatrix(getComputedStyle(node).transform);
        return Math.round(Math.hypot(matrix.a, matrix.b) * 1000) / 1000;
      }),
    )
    .toBe(3);
  expect(
    await glyph.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const edge = node
        .closest("[data-message-scroller]")
        .getBoundingClientRect().bottom;
      // Decorative glyphs intentionally ignore input; enable hit testing only for
      // this paint probe, then restore their production pointer behavior.
      node.style.pointerEvents = "auto";
      const matrix = new DOMMatrix(getComputedStyle(node).transform);
      const offset = node.offsetHeight * 0.4;
      const hit = document.elementFromPoint(
        rect.x + rect.width / 2 + matrix.c * offset,
        rect.y + rect.height / 2 + matrix.d * offset,
      );
      node.style.pointerEvents = "";
      return rect.bottom > edge && (hit === node || node.contains(hit));
    }),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("thread-floating-actions.png"),
  });
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
});

test("timeline actions escape the top edge, track scrolling and preserve keyboard order", async ({
  page,
  app,
  browserName,
}) => {
  const target = app.append(
    "primary",
    "alpha",
    "Floating timeline target\n\nMore text\n\nLast paragraph",
    false,
    true,
  );
  for (let i = 0; i < 8; i++)
    app.append(
      "primary",
      "alpha",
      `Following ${i}\n\nExtra space\n\nAnother paragraph\n\nLast paragraph`,
      false,
    );
  await open(page, app);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${target.id}"]`,
  );
  const actions = actionsFor(row);
  const scroller = page.getByRole("region", {
    name: "Channel message history",
  });
  await row.scrollIntoViewIfNeeded();
  await settle(page, scroller);
  if (browserName === "chromium") {
    await page.mouse.move(0, 0);
    const avatar = row
      .getByRole("button", { name: /^View .* profile$/ })
      .first();
    await avatar.focus();
    await shown(actions);
    await page.keyboard.press("Tab");
    await expect(actions.getByRole("button").first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(avatar).toBeFocused();
  }
  await actions.evaluate((bar) => {
    const scroller = bar.closest("[data-message-scroller]");
    scroller.scrollTop +=
      bar.parentElement.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      -10;
  });
  // That assignment is one scroll event, so Virtua holds the list's pointer
  // events at none for 150ms after it. Settled geometry alone can return inside
  // that window, and the raw move below is not retried against a hit target.
  await virtuaIdle(page, scroller);
  const bounds = await scroller.boundingBox();
  const rowBounds = await row.boundingBox();
  await page.mouse.move(rowBounds.x + 100, bounds.y + 35);
  await shown(actions);
  await expect
    .poll(() =>
      actions.evaluate((bar) => {
        const rect = bar.getBoundingClientRect();
        const edge = bar
          .closest("[data-message-scroller]")
          .getBoundingClientRect().top;
        return (
          rect.top < edge &&
          [rect.top + 2, rect.bottom - 2].every((y) =>
            bar.contains(document.elementFromPoint(rect.x + rect.width / 2, y)),
          )
        );
      }),
    )
    .toBe(true);
  // A focused row that remains mounted must not leave actions over the header.
  await actions.getByRole("button").first().focus();
  await page.mouse.move(0, 0);
  await scroller.evaluate((node) => {
    node.scrollTop += 300;
  });
  await settle(page, scroller);
  await expect(actions).toHaveCSS("opacity", "0");
  await scroller.hover();
  await wheel(page, -300, scroller);
  await row.getByText("Floating timeline target", { exact: true }).hover();
  await shown(actions);
  // Resize and RTL both preserve the same slot edge.
  await row.evaluate((node) => {
    node.dir = "rtl";
  });
  await page.setViewportSize({ width: 1000, height: 850 });
  await row.getByText("Floating timeline target", { exact: true }).hover();
  await expect
    .poll(() =>
      actions.evaluate((bar) =>
        Math.abs(
          bar.getBoundingClientRect().left -
            bar.parentElement.getBoundingClientRect().left,
        ),
      ),
    )
    .toBeLessThan(1);
});

// Browser-only: Base UI portals, native focus events and top-layer stacking.
test("keyboard search covers a toolbar under the pointer and restores its actions", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append("primary", "alpha", "Hovered Reply modal check");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const actions = actionsFor(row);
  const reply = actions.getByRole("button", { name: "Reply", exact: true });
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  for (const opener of [composer, reply]) {
    await row.hover();
    await shown(actions);
    await opener.focus();
    await reply.hover();
    const bounds = await reply.boundingBox();
    const point = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    await page.keyboard.press(`${modifier}+k`);
    const dialog = page.getByRole("dialog", {
      name: "Search Buzz",
      exact: true,
    });
    await expect(
      dialog.getByRole("combobox", { name: "Search Buzz" }),
    ).toBeFocused();
    await expect
      .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
      .toBe(false);
    await expect(actions).toHaveCSS("opacity", "0");
    expect(
      await actions.evaluate(
        (bar, point) =>
          bar.contains(document.elementFromPoint(point.x, point.y)),
        point,
      ),
    ).toBe(false);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await row.hover();
    await reply.hover();
    await shown(actions);
  }
  await reply.click();
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
});

test("menus and pickers retain actions, but modal dialogs cover them", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Floating portal check",
    true,
    false,
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const actions = actionsFor(row);
  await row.hover();
  const trigger = actions.getByRole("button", { name: "More message actions" });
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.hover();
  await shown(actions);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const composerBox = await composer.boundingBox();
  // The menu's modal overlay receives the outside click before the editor does.
  await page.mouse.click(composerBox.x + 20, composerBox.y + 10);
  await expect(menu).toBeHidden();
  await composer.click();
  await expect(actions).toHaveCSS("opacity", "0");
  await row.hover();
  await actions
    .getByRole("button", { name: "Add reaction", exact: true })
    .click();
  const search = page.locator('em-emoji-picker input[type="search"]');
  await expect(search).toBeVisible();
  await search.hover();
  await shown(actions);
  await page.mouse.click(composerBox.x + 20, composerBox.y + 10);
  await expect(search).toBeHidden();
  await composer.click();
  await expect(actions).toHaveCSS("opacity", "0");
  // Keep the pointer on the row while invoking the dialog by keyboard.
  await row.hover();
  await trigger.focus();
  await trigger.press("Enter");
  await page
    .getByRole("menuitem", { name: "Report", exact: true })
    .press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Report message",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(actions).toHaveCSS("opacity", "0");
  await expect
    .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
    .toBe(false);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  // Pointer dismissal restores focus without pinning an unhovered toolbar.
  await expect(actions).toHaveCSS("opacity", "0");
  await trigger.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await shown(actions);
  const own = app.append("primary", "alpha", "Delete confirmation check");
  const ownRow = page.locator(
    `[data-channel-timeline] [data-message-id="${own.id}"]`,
  );
  const ownActions = actionsFor(ownRow);
  await ownRow.hover();
  await ownActions
    .getByRole("button", { name: "More message actions" })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("menuitem", { name: "Delete message", exact: true })
    .press("Enter");
  const confirmation = page.getByRole("alertdialog", {
    name: "Delete message?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await expect(ownActions).toHaveCSS("opacity", "0");
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
});
