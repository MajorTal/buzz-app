import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

// Real font metrics, wrapping and parent layout need a browser, not jsdom.
test("Notifications keeps settings separated and button labels contained at supported text sizes", async ({
  page,
  app,
}, info) => {
  await page.addInitScript(() => {
    window.Notification = class {
      static permission = "default";
      static async requestPermission() {
        return "default";
      }
      close() {}
    };
  });
  await page.goto(app.origin);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+,`);
  const section = page.locator(
    'section[aria-labelledby="notification-settings-title"]',
  );
  for (const scale of [100, 200]) {
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    if (scale === 200) {
      for (let i = 0; i < 10; i++) {
        await page.getByRole("button", { name: "Increase text size" }).click();
      }
    }
    await expect(page.getByRole("status", { name: "Text size" })).toHaveText(
      `${scale}%`,
    );
    await page
      .getByRole("button", { name: "Notifications", exact: true })
      .click();
    await expect(
      section.getByRole("button", { name: "Allow notifications" }),
    ).toBeVisible();
    await expect(section.getByRole("switch")).toHaveCount(6);
    await page.evaluate(() => document.fonts.ready);
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      // Retrying the geometry assertions observes applied layout after resizing.
      const geometryIssues = () =>
        section.evaluate((root) => {
          const failures = [];
          const bounds = root.getBoundingClientRect();
          const controls = [...root.querySelectorAll('[role="switch"]')];
          let previous;
          for (const control of controls) {
            const row = control.parentElement.getBoundingClientRect();
            const name = control.getAttribute("aria-label");
            if (previous && row.top <= previous.bottom)
              failures.push(`${name}: settings share or overlap a row`);
            if (row.left < bounds.left || row.right > bounds.right)
              failures.push(`${name}: row overflows section`);
            const track = control.getBoundingClientRect();
            const label = document.createRange();
            label.selectNodeContents(control.previousElementSibling);
            for (const line of label.getClientRects()) {
              if (line.right > track.left || track.right > bounds.right)
                failures.push(`${name}: label or switch overflows its row`);
            }
            previous = row;
          }
          for (const button of root.querySelectorAll(
            'button:not([role="switch"])',
          )) {
            const box = button.getBoundingClientRect();
            const text = document.createRange();
            text.selectNodeContents(button);
            for (const line of text.getClientRects()) {
              if (
                line.top < box.top ||
                line.bottom > box.bottom ||
                line.left < box.left ||
                line.right > box.right
              ) {
                failures.push(`${button.textContent}: text overflows button`);
              }
            }
            if (box.left < bounds.left || box.right > bounds.right)
              failures.push(`${button.textContent}: button overflows section`);
          }
          return failures;
        });
      await expect
        .poll(geometryIssues, {
          message: `Notifications layout at ${scale}% text and ${width}px width`,
        })
        .toEqual([]);
      await page.screenshot({
        path: info.outputPath(`notifications-${scale}-${width}.png`),
      });
    }
  }
});
