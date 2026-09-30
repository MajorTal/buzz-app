import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

// Real CSS transitions, input modality, clipping, and pseudo-elements require a browser.
test("joined header seams, drag feedback, and pointer-only overlay motion", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  const launch = page
    .getByRole("button", { name: "Bestie", exact: true })
    .and(page.locator("button[aria-expanded]"));
  const close = page.getByRole("button", {
    name: "Close Bestie panel",
    exact: true,
  });
  const dock = page.locator("[data-panel-dock]");
  const resize = page.getByRole("separator", {
    name: "Resize channel sidebar",
  });

  await launch.click();
  await expect(close).toBeVisible();
  await expect(dock).toHaveCSS("transition-duration", "0.18s, 0.18s");
  for (const header of await page.locator(".shell-body .panel-header").all()) {
    expect(
      await header.evaluate((el) => {
        const style = getComputedStyle(el, "::after");
        return [style.left, style.right];
      }),
    ).toEqual(["0px", "0px"]);
  }
  await close.click();
  await expect(dock).toHaveCount(0);

  // Keep the native scrollbar unclipped, near the rail, with the capsule centered on it.
  const navigation = page.getByRole("navigation", {
    name: "Subscribed channels",
  });
  const scrollBounds = await navigation.boundingBox();
  const resizeBounds = await resize.boundingBox();
  const railCenter = resizeBounds.x + resizeBounds.width / 2 - 0.5;
  expect(railCenter - (scrollBounds.x + scrollBounds.width)).toBeCloseTo(2.5);
  const capsuleCenter = await resize.evaluate(
    (el) =>
      el.getBoundingClientRect().left +
      Number.parseFloat(getComputedStyle(el, "::after").left),
  );
  expect(capsuleCenter).toBeCloseTo(railCenter);
  expect(
    await navigation.evaluate((el) => {
      const frame = el.parentElement;
      return {
        clipped:
          el.getBoundingClientRect().right >
          frame.getBoundingClientRect().right,
        cap: getComputedStyle(frame, "::before").content,
        mask: getComputedStyle(frame, "::after").content,
      };
    }),
  ).toEqual({ clipped: false, cap: "none", mask: "none" });

  const grip = () =>
    resize.evaluate((el) => {
      const style = getComputedStyle(el, "::after");
      return {
        width: Number.parseFloat(style.width),
        height:
          Number.parseFloat(style.height) *
          new DOMMatrixReadOnly(style.transform).m22,
      };
    });
  expect((await grip()).width).toBe(3);
  expect((await grip()).height).toBeCloseTo(40, 2);
  const bounds = await resize.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  try {
    await expect(page.locator("html")).toHaveAttribute(
      "data-sidebar-resizing",
      "true",
    );
    expect(await grip()).toEqual({ width: 3, height: 56 });
    // Leave the handle vertically: active feedback must not depend on hover.
    await page.mouse.move(bounds.x + bounds.width / 2, 10);
    expect(
      await resize.evaluate((el) => [
        getComputedStyle(el, "::after").opacity,
        getComputedStyle(el, "::before").visibility,
      ]),
    ).toEqual(["1", "hidden"]);
  } finally {
    await page.mouse.up();
  }
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-sidebar-resizing",
  );

  await page.setViewportSize({ width: 800, height: 600 });
  // Hold real transitions as soon as they start; never race a 180ms duration.
  await page.evaluate(() => {
    document.addEventListener("transitionrun", (event) => {
      if (!event.target.matches("[data-panel-dock]")) return;
      for (const animation of event.target.getAnimations()) animation.pause();
      event.target.dataset.motionHeld = "true";
    });
  });
  const release = () =>
    dock.evaluateAll((elements) => {
      for (const element of elements) {
        delete element.dataset.motionHeld;
        for (const animation of element.getAnimations()) animation.finish();
      }
    });
  try {
    await launch.click();
    await expect(dock).toHaveAttribute("data-motion-held", "true");
    await expect(dock).toHaveCSS("transition-duration", "0.18s, 0.18s");
    expect(
      await dock.evaluate((el) =>
        el
          .getAnimations()
          .some((animation) =>
            animation.effect
              .getKeyframes()
              .some((frame) => frame.transform?.includes("100%")),
          ),
      ),
    ).toBe(true);
    await release();
    await expect(dock).toHaveCSS("transform", "none");
    await close.click();
    await expect(dock).toHaveAttribute("data-closing");
    await expect(dock).toHaveAttribute("inert");
    await expect(dock).toHaveAttribute("data-motion-held", "true");
    await expect(dock).toHaveCSS("transition-duration", "0.12s");
    await release();
    await expect(dock).toHaveCount(0);

    await launch.press("Enter");
    await expect(close).toBeVisible();
    await expect(dock).toHaveCSS("transition-duration", "0s");
    await close.press("Enter");
    await expect(dock).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await launch.click();
    await expect(dock).toHaveAttribute("data-motion-held", "true");
    await expect(dock).toHaveCSS("transform", "none");
    await expect(dock).toHaveCSS("transition-property", "opacity");
    await release();
    await page.screenshot({
      path: testInfo.outputPath("joined-panel-polish.png"),
    });
    await close.click();
    await expect(dock).toHaveAttribute("data-motion-held", "true");
    await release();
    await expect(dock).toHaveCount(0);
  } finally {
    await release();
  }
});

// Actual grid geometry and resize input need a browser, including the host fallback.
for (const destination of ["Messages", "Projects"]) {
  test(`${destination} main and secondary panels resize without resetting content`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(app.origin);
    await openPage(page, destination);
    const launch = page
      .getByRole("button", { name: "Bestie", exact: true })
      .and(page.locator("button[aria-expanded]"));
    const close = page.getByRole("button", {
      name: "Close Bestie panel",
      exact: true,
    });
    await launch.click();
    const handle = page.getByRole("separator", {
      name: "Resize main and secondary panels",
    });
    const dock = page.locator("[data-panel-dock]");
    await expect(handle).toBeVisible();
    await dock.evaluate(async (el) => {
      await Promise.allSettled(
        el.getAnimations().map((animation) => animation.finished),
      );
    });
    const initial = await dock.boundingBox();
    const grip = await handle.boundingBox();
    // The capsule aligns to the dock's 1px leading divider.
    expect(
      await handle.evaluate(
        (el) =>
          el.getBoundingClientRect().left +
          Number.parseFloat(getComputedStyle(el, "::after").left),
      ),
    ).toBeCloseTo(initial.x + 0.5);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(
        grip.x + grip.width / 2 - 80,
        grip.y + grip.height / 2,
      );
      await expect
        .poll(async () => (await dock.boundingBox()).width)
        .toBeCloseTo(initial.width + 80, 0);
    } finally {
      await page.mouse.up();
    }
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-sidebar-resizing",
    );
    await handle.press("ArrowRight");
    await expect
      .poll(async () => (await dock.boundingBox()).width)
      .toBeCloseTo(initial.width + 64, 0);
    const adjusted = (await dock.boundingBox()).width;
    await close.click();
    await expect(dock).toHaveCount(0);
    await launch.click();
    await expect
      .poll(async () => (await dock.boundingBox()).width)
      .toBeCloseTo(adjusted, 0);
    await handle.press("Home");
    await expect
      .poll(async () => (await dock.boundingBox()).width)
      .toBeCloseTo(destination === "Messages" ? 316 : 300, 0);
    await handle.press("End");
    expect(
      await dock.evaluate(
        (el) => el.parentElement.clientWidth - el.getBoundingClientRect().width,
      ),
    ).toBeCloseTo(320, 0);
    await handle.dblclick();
    await expect
      .poll(async () => (await dock.boundingBox()).width)
      .toBeCloseTo(initial.width, 0);
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(handle).toBeHidden();
    await expect(dock).toHaveCSS("position", "absolute");
    await expect(dock).toHaveCSS("width", "420px");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(handle).toBeVisible();
    const finalGrip = await handle.boundingBox();
    await page.mouse.move(finalGrip.x + 8, finalGrip.y + finalGrip.height / 2);
    await page.mouse.down();
    try {
      await expect(page.locator("html")).toHaveAttribute(
        "data-sidebar-resizing",
        "true",
      );
      await close.press("Enter");
      await expect(handle).toHaveCount(0);
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-sidebar-resizing",
      );
      await expect(page.locator("body")).not.toHaveCSS("user-select", "none");
    } finally {
      await page.mouse.up();
    }
  });
}

for (const destination of ["Messages", "Projects"]) {
  test(`${destination} desktop panel enters and exits without collapsing its split early`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(app.origin);
    await openPage(page, destination);
    const launch = page
      .getByRole("button", { name: "Bestie", exact: true })
      .and(page.locator("button[aria-expanded]"));
    const close = page.getByRole("button", {
      name: "Close Bestie panel",
      exact: true,
    });
    const dock = page.locator("[data-panel-dock]");
    await page.evaluate(() =>
      document.addEventListener("transitionrun", (event) => {
        if (!event.target.matches("[data-panel-dock]")) return;
        for (const animation of event.target.getAnimations()) animation.pause();
        event.target.dataset.motionHeld = "true";
      }),
    );
    const release = () =>
      dock.evaluateAll((elements) => {
        for (const element of elements) {
          delete element.dataset.motionHeld;
          for (const animation of element.getAnimations()) animation.finish();
        }
      });
    try {
      await launch.click();
      await expect(dock).toHaveAttribute("data-motion-held", "true");
      await expect(dock).toHaveCSS("transition-duration", "0.18s, 0.18s");
      expect(
        await dock.evaluate((el) =>
          el
            .getAnimations()
            .some((animation) =>
              animation.effect
                .getKeyframes()
                .some(
                  (frame) =>
                    typeof frame.transform === "string" &&
                    new DOMMatrix(frame.transform).m41 === 12,
                ),
            ),
        ),
      ).toBe(true);
      await release();
      await expect(dock).toHaveCSS("transform", "none");
      const split = await dock.evaluate((el) => ({
        width: getComputedStyle(el).width,
        columns: getComputedStyle(el.parentElement).gridTemplateColumns,
      }));
      await close.click();
      await expect(dock).toHaveAttribute("data-motion-held", "true");
      await expect(dock).toHaveAttribute("inert");
      await expect(dock).toHaveCSS("transition-duration", "0.12s");
      expect(
        await dock.evaluate((el) => ({
          width: getComputedStyle(el).width,
          columns: getComputedStyle(el.parentElement).gridTemplateColumns,
        })),
      ).toEqual(split);
      // Reverse the held exit: stale completion must not remove the reopened dock.
      await launch.click();
      await expect(dock).not.toHaveAttribute("data-closing");
      await release();
      await expect(close).toBeVisible();
      await close.click();
      await expect(dock).toHaveAttribute("data-motion-held", "true");
      await release();
      await expect(dock).toHaveCount(0);
      await launch.press("Enter");
      await expect(dock).toHaveCSS("transition-duration", "0s");
      await close.press("Enter");
      await expect(dock).toHaveCount(0);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await launch.click();
      await expect(dock).toHaveAttribute("data-motion-held", "true");
      await expect(dock).toHaveCSS("transform", "none");
      await expect(dock).toHaveCSS("transition-property", "opacity");
    } finally {
      await release();
    }
  });
}
