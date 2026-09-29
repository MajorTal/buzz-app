import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 3, beta: 1 },
});

// Browser-only boundary: real composer -> signing broker -> live nested row;
// layout/focus at different panel widths, and routed reveal through collapsed DOM.
test("nested replies send, collapse, and reveal through links at readable panel widths", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const editor = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const parent = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Unread reply 0" });
  const history = panel.getByRole("region", { name: "Thread messages" });
  await expect(panel.locator('[data-depth="-1"]')).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Hide thread replies", exact: true }),
  ).toHaveCount(0);
  // Ordinary replies are direct siblings, not children of a collapsible panel.
  await expect(
    history.locator(":scope > ol > li").filter({
      has: page
        .locator("[data-message-id]")
        .filter({ hasText: "Unread reply 0" }),
    }),
  ).toHaveCount(1);
  const ordinaryGeometry = await parent.evaluate((node) => {
    const item = node.closest("li");
    const root = node
      .closest('[aria-label="Thread messages"]')
      .querySelector("[data-message-id]");
    return {
      rootLeft: root.getBoundingClientRect().left,
      replyLeft: node.getBoundingClientRect().left,
      connector: getComputedStyle(item, "::after").content,
    };
  });
  expect(ordinaryGeometry.replyLeft).toBe(ordinaryGeometry.rootLeft);
  expect(ordinaryGeometry.connector).toBe("none");
  await panel.screenshot({
    path: test.info().outputPath("ordinary-thread-replies.png"),
  });
  await editor.fill("Nested browser reply");
  await parent.hover();
  await parent.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(editor).toHaveText("Nested browser reply");
  let rejected;
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (!rejected && event.content === "Nested browser reply") {
      rejected = event;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: false,
          event_id: event.id,
          message: "Fixture rejection",
        }),
      });
    } else await route.continue();
  });
  await editor.press("Enter");
  const failed = panel
    .locator("[data-message-id]")
    .filter({ hasText: "Nested browser reply" });
  await expect(
    failed.getByText("Couldn’t send this message.", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect
    .poll(
      () =>
        app.report.publications.filter(
          ({ event }) => event?.content === "Nested browser reply",
        ).length,
    )
    .toBe(1);
  const nested = app.report.publications.find(
    ({ event }) => event?.content === "Nested browser reply",
  ).event;
  // Compare signed wire fields, not the verifier’s local symbol cache.
  expect(JSON.parse(JSON.stringify(nested))).toEqual(rejected);
  expect(nested.tags.filter(([key]) => key === "e")).toEqual([
    ["e", root.id, "", "root"],
    ["e", await parent.getAttribute("data-message-id"), "", "reply"],
  ]);
  const nestedRow = panel.locator(`[data-message-id="${nested.id}"]`);
  await expect(nestedRow).toBeInViewport();
  // Morgan's continuation treatment uses a left-hand timestamp, not an elbow.
  const connector = await nestedRow.evaluate(
    (node) => getComputedStyle(node.closest("li"), "::before").content,
  );
  expect(connector).toBe("none");

  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await nestedRow.hover();
  await nestedRow.getByRole("button", { name: "Reply", exact: true }).click();
  // Main's Up-to-edit shares this composer; cancel must retain the nested target
  // and the native draft history, rather than sending the draft to the root.
  await editor.fill("Unsent nested draft");
  await editor.fill("");
  await editor.press("ArrowUp");
  const editInput = panel.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(editInput).toBeFocused();
  await expect(editInput).toHaveJSProperty("value", "Nested browser reply");
  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await editInput.press("Escape");
  await expect(editor).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveJSProperty("value", "Unsent nested draft");
  await editor.fill("Grandchild browser reply");
  let releaseGrandchild;
  let grandchildRequested = false;
  const grandchildGate = new Promise((resolve) => {
    releaseGrandchild = resolve;
  });
  await page.route("**/api/relay/**/publish", async (route) => {
    if (route.request().postDataJSON().content === "Grandchild browser reply") {
      grandchildRequested = true;
      await grandchildGate;
      await route.continue();
    } else await route.fallback();
  });
  await editor.press("Enter");
  try {
    const pending = panel
      .locator("[data-message-id]")
      .filter({ hasText: "Grandchild browser reply" });
    await expect(pending.locator('[data-layout="continuation"]')).toBeVisible();
    await expect.poll(() => grandchildRequested).toBe(true);
    await expect(
      pending.getByRole("button", { name: "Reply", exact: true }),
    ).toBeDisabled();
  } finally {
    releaseGrandchild();
  }
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) => event?.content === "Grandchild browser reply",
      ),
    )
    .toBe(true);
  const grandchild = app.report.publications.find(
    ({ event }) => event?.content === "Grandchild browser reply",
  ).event;
  expect(grandchild.tags.filter(([key]) => key === "e")).toEqual([
    ["e", root.id, "", "root"],
    ["e", nested.id, "", "reply"],
  ]);
  const grandchildRow = panel.locator(`[data-message-id="${grandchild.id}"]`);
  await expect(grandchildRow).toBeInViewport();
  await expect(editor).toBeFocused();
  // The same-author continuation clock is quiet until hover or keyboard focus.
  const clock = grandchildRow.locator("time");
  await editor.focus();
  await editor.hover();
  await expect(clock).toHaveCSS("opacity", "0");
  await grandchildRow.hover();
  await expect(clock).toHaveCSS("opacity", "1");
  await clock.hover();
  await expect(page.getByRole("tooltip")).toContainText(/\d{4}/);
  await grandchildRow
    .getByRole("button", { name: "Reply", exact: true })
    .focus();
  await editor.hover();
  await expect(clock).toHaveCSS("opacity", "1");
  await editor.focus();
  await parent
    .locator("../..")
    .getByRole("button", { name: "Hide replies", exact: true })
    .first()
    .click();
  await expect(nestedRow).toHaveCount(0);
  await parent
    .locator("../..")
    .getByRole("button", { name: /^View 2 replies/ })
    .click();
  await expect(nestedRow).toBeVisible();
  await expect(grandchildRow).toHaveCount(0);
  await nestedRow
    .locator("../..")
    .getByRole("button", { name: /^View 1 reply/ })
    .click();
  await expect(grandchildRow).toBeVisible();

  let deepest = grandchildRow;
  for (let depth = 0; depth < 6; depth++) {
    await editor.hover();
    await deepest.hover();
    await deepest.getByRole("button", { name: "Reply", exact: true }).click();
    const content = `Deep reply ${depth}`;
    await editor.fill(content);
    await editor.press("Enter");
    await expect
      .poll(() =>
        app.report.publications.some(({ event }) => event?.content === content),
      )
      .toBe(true);
    const event = app.report.publications.find(
      ({ event }) => event?.content === content,
    ).event;
    deepest = panel.locator(`[data-message-id="${event.id}"]`);
    await expect(deepest).toBeInViewport();
  }
  // Include phone widths with the persistent sidebar still visible.
  for (const width of [1492, 1280, 1024, 524, 522, 480, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await deepest.scrollIntoViewIfNeeded();
    const geometry = await panel.evaluate((element) => {
      const history = element.querySelector('[aria-label="Thread messages"]');
      const rail = [
        ...element.querySelectorAll('button[aria-label="Hide replies"]'),
      ].find(
        (node) =>
          getComputedStyle(node).position === "absolute" &&
          node.getClientRects().length,
      );
      return {
        width: history.clientWidth,
        scroll: history.scrollWidth,
        rail: rail?.getBoundingClientRect().width,
      };
    });
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    // At the narrowest cap all rails yield to per-row collapse controls.
    if (geometry.rail !== undefined)
      expect(geometry.rail).toBeGreaterThanOrEqual(24);
    else
      await expect(
        parent.getByRole("button", { name: "Collapse this branch" }),
      ).toBeVisible();
    const deepestBox = await deepest.boundingBox();
    expect(deepestBox.width).toBeGreaterThan(140);
    const capped = deepest.locator(
      'xpath=ancestor::*[@data-depth and @data-open="true"][1]',
    );
    await expect(capped.locator(":scope > div").nth(1)).toBeHidden();
    const rail = capped.locator(
      ":scope > [id] > button[aria-label='Hide replies']",
    );
    await expect(rail).toBeHidden();
    await expect(
      capped.getByRole("button", { name: "Collapse this branch" }).first(),
    ).toBeVisible();
    const spine = await capped.evaluate((node) => {
      const message = node.firstElementChild;
      return {
        stub: getComputedStyle(message, "::after").display,
        offset: getComputedStyle(message, "::after").left,
      };
    });
    expect(spine.stub).not.toBe("none");
    expect(parseFloat(spine.offset)).toBeLessThan(0);

    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (mode) =>
          document.documentElement.setAttribute("data-color-mode", mode),
        theme,
      );
      await expect(
        panel.locator('button[aria-label="Hide replies"]').last(),
      ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await panel.screenshot({
        path: test.info().outputPath(`nested-${width}-${theme}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  const parentBranch = parent.locator("../..");
  const collapseBranch = parentBranch
    .getByRole("button", { name: "Hide replies", exact: true })
    .first();
  await collapseBranch.focus();
  await collapseBranch.press("Enter");
  await expect(parent).toBeVisible();
  await expect(nestedRow).toHaveCount(0);
  const reopenBranch = parentBranch.getByRole("button", {
    name: /^View \d+ replies/,
  });
  await expect(reopenBranch).toBeFocused();
  await reopenBranch.press("Enter");
  await expect(nestedRow).toBeVisible();
  await expect(grandchildRow).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  const linked = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${grandchild.id}>`,
  );
  const linkRow = page.locator(
    `[data-channel-timeline] [data-message-id="${linked.id}"]`,
  );
  await linkRow.getByRole("link", { name: "Alpha", exact: true }).click();
  await expect(grandchildRow).toBeInViewport();
  await expect(grandchildRow).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("opened");
  // A later live update must not undo an explicit collapse after revealing a link.
  await parent
    .locator("../..")
    .getByRole("button", { name: "Hide replies", exact: true })
    .first()
    .click();
  app.reply(root.id);
  await expect(
    panel.getByText("New peer reply", { exact: true }),
  ).toBeVisible();
  await expect(grandchildRow).toHaveCount(0);
  await expect(parent).toBeVisible();
  // Sending to the thread must not reopen a separately collapsed nested branch.
  await editor.fill("Own ordinary thread reply");
  await editor.press("Enter");
  await expect(
    panel.getByText("Own ordinary thread reply", { exact: true }),
  ).toBeInViewport();
  // The optimistic row is visible before relay acceptance. Keep the production
  // subscription alive until publication and delivery settle, then end the test.
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) => event?.content === "Own ordinary thread reply",
      ),
    )
    .toBe(true);
  await expect(grandchildRow).toHaveCount(0);
  await expect(nestedRow).toHaveCount(0);
  await expect(parent).toBeVisible();
  const finalReply = app.report.publications.find(
    ({ event }) => event?.content === "Own ordinary thread reply",
  ).event;
  await expect(
    panel
      .locator(`[data-message-id="${finalReply.id}"]`)
      .getByRole("button", { name: "Reply", exact: true }),
  ).toBeEnabled();
});

test("an exact linked reply stays readable when its parent is outside loaded history", async ({
  page,
  app,
}) => {
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  // Peer-authored rows never enter this viewer's persistent outbox. The bounded
  // history contains the child and root, but not the intermediate parent.
  const child = app.append(
    "primary",
    "alpha",
    "Exact orphan reply",
    false,
    false,
    root.id,
    "a".repeat(64),
  );
  const link = app.append(
    "primary",
    "alpha",
    `Open <buzz://message?channel=alpha&id=${child.id}>`,
    false,
  );
  await open(page, app);
  await page
    .locator(`[data-channel-timeline] [data-message-id="${link.id}"]`)
    .getByRole("link", { name: "Alpha", exact: true })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const orphan = panel.locator(`[data-message-id="${child.id}"]`);
  await expect(orphan).toBeFocused();
  await expect(orphan).toBeInViewport();
  await expect(
    panel.getByText("Earlier reply unavailable in loaded history.", {
      exact: true,
    }),
  ).toBeVisible();
});

test.describe("touch branch controls", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("keeps a visible collapse label without hover", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 0");
    const thread = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    // This case exercises touch controls inside the thread, not the virtualized feed's pointer lock.
    await thread.focus();
    await thread.press("Enter");
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const summary = panel.getByRole("button", { name: /^View 1 reply/ });
    await expect(summary).toContainText("(1 new)");
    await summary.tap();
    const collapse = panel.getByRole("button", {
      name: "Hide replies",
      exact: true,
    });
    await expect(collapse).toHaveText("Hide replies");
    const history = panel.getByRole("region", { name: "Thread messages" });
    const geometry = await history.evaluate((node) => ({
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    const branch = collapse.locator("../..");
    const spine = await branch.evaluate((node) => ({
      stub: getComputedStyle(node.firstElementChild, "::after").display,
      summary: getComputedStyle(node.children[1], "::before").display,
    }));
    expect(spine.stub).not.toBe("none");
    expect(spine.summary).not.toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motion = await branch.locator(":scope > [id]").evaluate((node) => ({
      transition: getComputedStyle(node).transitionDuration,
      animation: getComputedStyle(node).animationDuration,
    }));
    expect(motion).toEqual({ transition: "0s", animation: "0s" });

    await collapse.tap();
    await expect(summary).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Hide thread replies", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByText("Unread reply 0", { exact: true }),
    ).toBeVisible();
    await summary.tap();
    await expect(collapse).toHaveText("Hide replies");
    await collapse.tap();
    await expect(summary).toBeVisible();
  });
});

// Real pointer hit testing and focus cannot be verified in jsdom.
for (const width of [1492, 1280, 1024, 390])
  test(`crowded capped branches own distinct collapse controls at ${width}`, async ({
    page,
    app,
  }) => {
    const root = app.histories
      .get("primary/alpha")
      .find((e) => e.content === "Thread root 0");
    let parent = root.id;
    const ids = [];
    for (let i = 0; i < 13; i++) {
      parent = app.append(
        "primary",
        "alpha",
        `Crowded reply ${i}`,
        false,
        i < 9 ? i % 2 === 0 : true,
        root.id,
        parent,
      ).id;
      ids.push(parent);
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
    const branchFor = (id) =>
      panel.locator(`[data-message-id="${id}"]`).locator("../..");
    const expandAll = async () => {
      for (const id of ids.slice(0, -1)) {
        const branch = branchFor(id);
        if ((await branch.getAttribute("data-open")) === "false")
          await branch
            .locator(":scope > div")
            .nth(1)
            .getByRole("button")
            .click();
      }
    };
    await page.setViewportSize({ width, height: 950 });
    await expandAll();
    for (const id of ids.slice(0, -1)) {
      const branch = branchFor(id);
      const rail = branch.locator(
        ":scope > [id] > button[aria-label='Hide replies']",
      );
      const rowControl = branch
        .locator(":scope > div")
        .first()
        .getByRole("button", { name: "Collapse this branch" });
      const control = (await rail.isVisible()) ? rail : rowControl;
      await control.scrollIntoViewIfNeeded();
      if (control === rowControl) await control.focus();
      await expect
        .poll(() =>
          control.evaluate((node) => {
            const r = node.getBoundingClientRect();
            const viewport = node
              .closest('[aria-label="Thread messages"]')
              .getBoundingClientRect();
            const top = Math.max(r.top, viewport.top);
            const bottom = Math.min(r.bottom, viewport.bottom);
            if (bottom <= top) return false;
            const hit = document.elementFromPoint(
              r.x + r.width / 2,
              (top + bottom) / 2,
            );
            return node === hit || node.contains(hit);
          }),
        )
        .toBe(true);
      const row = panel.locator(`[data-message-id="${id}"]`);
      await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
      await panel.getByRole("heading", { name: "Thread", exact: true }).hover();
      await row.scrollIntoViewIfNeeded();
      const restingHeight = (await row.boundingBox()).height;
      await row.hover();
      expect((await row.boundingBox()).height).toBe(restingHeight);
      const actions = row.getByRole("group", { name: "Message actions" });
      await expect(actions).toHaveCSS("opacity", "1");
      // Test rendered text fragments, not a block whose empty area may overlap.
      // Hover actions must leave this row's own message and its neighbor readable.
      await expect
        .poll(() =>
          row.evaluate((node) => {
            const tray = node
              .querySelector('[aria-label="Message actions"]')
              .getBoundingClientRect();
            const walker = document.createTreeWalker(
              node,
              NodeFilter.SHOW_TEXT,
            );
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              if (!text.textContent.startsWith("Crowded reply")) continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              for (const rect of range.getClientRects()) {
                if (
                  tray.left < rect.right &&
                  tray.right > rect.left &&
                  tray.top < rect.bottom &&
                  tray.bottom > rect.top
                )
                  return true;
              }
            }
            return false;
          }),
        )
        .toBe(false);
      await control.hover();
      await expect
        .poll(() =>
          branch.evaluate((node) =>
            getComputedStyle(node).getPropertyValue("--reply-guide").trim(),
          ),
        )
        .toBe("gray");
      const child = ids[ids.indexOf(id) + 1];
      await control.click();
      await expect(panel.locator(`[data-message-id="${id}"]`)).toBeVisible();
      await expect(panel.locator(`[data-message-id="${child}"]`)).toHaveCount(
        0,
      );
      const summary = branch.locator(":scope > div").nth(1).getByRole("button");
      await expect(summary).toBeFocused();
      await summary.press("Enter");
      await expect(control).toBeFocused();
      await expect(panel.locator(`[data-message-id="${child}"]`)).toBeVisible();
      await expandAll();
    }
    await panel.getByRole("textbox", { name: "Reply to thread" }).focus();
    await panel.getByRole("heading", { name: "Thread", exact: true }).hover();
    for (const id of ids) {
      await expect(
        panel
          .locator(`[data-message-id="${id}"]`)
          .getByRole("group", { name: "Message actions" }),
      ).toHaveCSS("opacity", "0");
    }
    await panel.screenshot({
      path: test.info().outputPath(`crowded-${width}.png`),
    });
  });
