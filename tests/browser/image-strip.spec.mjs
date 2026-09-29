import { test, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "./vite-server.mjs";

// Browser-only: posted layout, overflow, focus scrolling and real viewer wiring.
test("posted image strips keep counts visible and every image reachable beside documents", async ({
  page,
  browserName,
}, testInfo) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/relay-composer.html?attachments`,
    );
    const form = page.getByRole("form", {
      name: "Send a message to General",
      exact: true,
    });
    await expect(
      form.getByRole("button", { name: "Attach files", exact: true }),
    ).toBeEnabled();
    const pictures = Array.from({ length: 8 }, (_, i) => ({
      name: `sample-${i + 1}.svg`,
      mimeType: "image/svg+xml",
      buffer: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${i % 2 ? 400 : 900}" height="600"><rect width="100%" height="100%" fill="${i % 2 ? "#d9e7e3" : "#ebdfd4"}"/><circle cx="200" cy="180" r="90" fill="#cda97c"/><path d="M0 600 L250 250 L650 600" fill="#859e89"/><text x="30" y="60" font-size="32">${i + 1}</text></svg>`,
      ),
    }));
    await form.getByLabel("Choose attachments").setInputFiles([
      {
        name: "Design-review.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\nSynthetic fixture"),
      },
      {
        name: "Meeting-notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Sample notes"),
      },
      ...pictures,
    ]);
    await expect(form.getByText(/Ready$/)).toHaveCount(10);
    await form.getByRole("textbox").fill("Design references and review notes");
    await form
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    const strip = history.getByRole("group", { name: "8 images", exact: true });
    const links = strip.getByRole("link");
    await expect(links).toHaveCount(8);
    await expect(history.getByText("8 images", { exact: true })).toBeVisible();
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(strip).toBeVisible();
      const geometry = await links.evaluateAll((items) =>
        items.map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, width: r.width, height: r.height };
        }),
      );
      expect(
        geometry.every(
          (r) =>
            r.top === geometry[0].top &&
            r.width === geometry[0].width &&
            r.height === r.width,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const files = history.getByRole("link", {
        name: /Download (Design-review.pdf|Meeting-notes.md)/,
      });
      await expect(files).toHaveCount(2);
      const boxes = await files.evaluateAll((items) =>
        items.map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        }),
      );
      expect(boxes[1].x > boxes[0].right || boxes[1].y > boxes[0].bottom).toBe(
        true,
      );
      await links.first().focus();
      for (let i = 1; i < 8; i++)
        await page.keyboard.press(
          browserName === "webkit" && process.platform === "darwin"
            ? "Alt+Tab"
            : "Tab",
        );
      await expect(links.last()).toBeFocused();
      await expect
        .poll(() =>
          links.last().evaluate((el) => {
            const a = el.getBoundingClientRect(),
              b = el.parentElement.getBoundingClientRect();
            return a.left >= b.left && a.right <= b.right;
          }),
        )
        .toBe(true);
      await expect(links.last()).toHaveCSS("outline-style", "solid");
      // A declared outline can still be clipped away. Compare actual pixels
      // while changing only its color, not focus, scrolling, or layout.
      await links
        .last()
        .evaluate((el) => el.setAttribute("data-focus-probe", ""));
      const mask = [links.locator("img, canvas")];
      const focused = await strip.screenshot({ mask });
      const hiddenOutline = await strip.screenshot({
        mask,
        style: "[data-focus-probe] { outline-color: transparent !important; }",
      });
      expect(focused.equals(hiddenOutline)).toBe(false);
      await links
        .last()
        .evaluate((el) => el.removeAttribute("data-focus-probe"));
      await expect(
        history.getByText("8 images", { exact: true }),
      ).toBeVisible();
      await links.first().focus();
      await expect
        .poll(() =>
          links
            .first()
            .locator("img")
            .evaluate(
              (el) =>
                el.naturalWidth > 0 &&
                getComputedStyle(el).visibility === "visible",
            ),
        )
        .toBe(true);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (theme) =>
            document.documentElement.setAttribute("data-color-mode", theme),
          theme,
        );
        await page
          .getByRole("article", { name: "Conversation", exact: true })
          .screenshot({
            path: testInfo.outputPath(`strip-${width}-${theme}.png`),
            style:
              '[aria-label="App notifications"] { visibility: hidden !important; }',
          });
      }
    }
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.composerFixture
            .pending()
            .every((item) => ["accepted", "seen"].includes(item.delivery)),
        ),
      )
      .toBe(true);
    await links.last().focus();
    const lastSource = await links.last().locator("img").getAttribute("src");
    await page.keyboard.press("Enter");
    const viewer = page.getByRole("dialog", {
      name: "Image viewer",
      exact: true,
    });
    await expect(
      viewer.getByRole("img", { name: "Attachment preview" }),
    ).toHaveAttribute("src", lastSource);
    await expect(viewer.getByText("8 / 8", { exact: true })).toBeVisible();
    await viewer
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(links.last()).toBeFocused();

    // Pointer activation uses the new shared-image motion; keyboard skips it.
    await page.evaluate(() => {
      window.stripMotionFrames = [];
      const animate = HTMLElement.prototype.animate;
      HTMLElement.prototype.animate = function (frames, options) {
        if (this.hasAttribute("data-review-media"))
          window.stripMotionFrames.push(frames);
        return animate.call(this, frames, options);
      };
    });
    await links.first().click();
    await expect(viewer).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.stripMotionFrames.length))
      .toBeGreaterThan(0);
    await expect(viewer).not.toHaveAttribute("data-review-opening");
    const motion = await page.evaluate(() => {
      const media = document.querySelector("[data-review-media]");
      const bounds = media.getBoundingClientRect();
      const height =
        bounds.height -
        (parseFloat(getComputedStyle(media).paddingBottom) || 0);
      const tile = document.querySelector("[data-thumbnail]");
      const image = tile.querySelector("img");
      const aspect = image.naturalWidth / image.naturalHeight;
      const preview = tile.getBoundingClientRect();
      const coverWidth = Math.max(preview.width, preview.height * aspect);
      const targetWidth = Math.min(bounds.width, height * aspect);
      return {
        frames: window.stripMotionFrames,
        scale: coverWidth / targetWidth,
      };
    });
    const start = motion.frames[0][0];
    expect(Number(start.transform.match(/scale\(([^)]+)\)/)[1])).toBeCloseTo(
      motion.scale,
      5,
    );
    expect(start.clipPath).toBeTruthy();
    await expect(viewer).not.toHaveAttribute("data-review-opening");
    await viewer
      .getByRole("button", { name: "Close fullscreen viewer" })
      .click();
    await expect(viewer).toHaveCount(0);
    await expect(links.first()).toBeFocused();
  } finally {
    await server.close();
  }
});
