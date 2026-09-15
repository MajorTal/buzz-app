import { expect, test } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Sample actual browser paint, not just shape attributes or bounding boxes.
async function pixels(page, locator, inset = 0) {
  await locator.scrollIntoViewIfNeeded();
  const bounds = await locator.boundingBox();
  // Browser crops round outward to device pixels. Keep the fractional artwork
  // origin rather than treating that rounded image as the avatar's own bounds.
  const clip = {
    x: Math.floor(bounds.x),
    y: Math.floor(bounds.y),
    width: Math.ceil(bounds.x + bounds.width) - Math.floor(bounds.x),
    height: Math.ceil(bounds.y + bounds.height) - Math.floor(bounds.y),
  };
  const png = await page.screenshot({ clip, scale: "css" });
  return page.evaluate(
    async ({ base64, inset, bounds, clip }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const at = (fraction) => [
        ...context.getImageData(
          Math.floor(
            bounds.x - clip.x + inset + (bounds.width - 2 * inset) * fraction,
          ),
          Math.floor(
            bounds.y - clip.y + inset + (bounds.height - 2 * inset) * fraction,
          ),
          1,
          1,
        ).data,
      ];
      // One pixel inside the inset exposes a missing inner clip; its exact
      // outermost corner can still be clipped by the parent's mask alone.
      return {
        corner: at(inset ? 0.05 : 0),
        shoulder: at(0.1),
        center: at(0.5),
      };
    },
    { base64: png.toString("base64"), inset, bounds, clip },
  );
}

test("avatar shapes paint at every size and preserve pointer/keyboard profile controls", async ({
  page,
  browserName,
}, testInfo) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/avatar-shapes.html`,
    );
    const avatars = page.locator("[data-avatar-shape]");
    await expect(avatars).toHaveCount(15);
    for (const image of await avatars.locator("img").all()) {
      await expect
        .poll(() => image.evaluate((el) => el.complete && el.naturalWidth > 0))
        .toBe(true);
      await expect(image).toHaveCSS("opacity", "1");
    }
    const system = page.getByRole("region", { name: "System avatars" });
    const insetAvatars = page.locator(
      "button[aria-label^='View thread:'] [data-avatar-shape], [data-membership-row] [data-avatar-shape]",
    );
    await expect(insetAvatars).toHaveCount(4);
    async function expectInsetArtwork(pictures = true) {
      for (const avatar of await insetAvatars.all()) {
        const shape = await avatar.getAttribute("data-avatar-shape");
        const size = await avatar.evaluate((el) =>
          el.closest("[data-membership-row]") ? 28 : 24,
        );
        await expect(avatar).toHaveCSS("width", `${size}px`);
        await expect(avatar).toHaveCSS("height", `${size}px`);
        await expect(avatar).toHaveCSS("border-width", "2px");
        for (const image of await avatar.locator("img").all()) {
          await expect(image).toHaveCSS("width", `${size - 4}px`);
          await expect(image).toHaveCSS("height", `${size - 4}px`);
        }
        // Sample inside the overlap border: an outer mask alone leaves the
        // actual image/fallback corners square even when its CSS says squircle.
        const paint = await pixels(page, avatar, 2);
        const surface = await avatar.evaluate((el) => {
          const rgb = getComputedStyle(el)
            .borderTopColor.match(/\d+/g)
            .map(Number);
          return [...rgb.slice(0, 3), 255];
        });
        const artwork = pictures
          ? [255, 0, 255, 255]
          : await avatar
              .locator("span")
              .first()
              .evaluate((el) => {
                const rgb = getComputedStyle(el)
                  .backgroundColor.match(/\d+/g)
                  .map(Number);
                return [...rgb.slice(0, 3), 255];
              });
        // Edge pixels are antialiased at these tiny sizes. Compare whether the
        // pixel is mostly background or artwork, rather than demanding zero
        // coverage at the boundary (or confusing photo texture with clipping).
        const distance = (pixel, color) =>
          pixel.reduce((sum, value, i) => sum + (value - color[i]) ** 2, 0);
        expect(
          distance(paint.corner, surface),
          `${shape}: inset corner is clipped`,
        ).toBeLessThan(distance(paint.corner, artwork));
        if (pictures)
          expect(paint.center, "inset picture is painted").toEqual(artwork);
        if (shape === "squircle")
          // At 20px the shoulder itself can be mostly antialiasing. It must
          // still paint beyond the clipped corner, not promise full coverage.
          expect(
            distance(paint.shoulder, artwork),
            "inset squircle retains its shoulder",
          ).toBeLessThan(distance(paint.corner, artwork));
        else
          expect(
            distance(paint.shoulder, surface),
            "inset human avatar stays circular",
          ).toBeLessThan(distance(paint.shoulder, artwork));
      }
    }
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      for (const width of [390, 900, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        for (const avatar of await avatars.all()) {
          const shape = await avatar.getAttribute("data-avatar-shape");
          await expect(avatar).toHaveCSS("clip-path", "none");
          await expect(avatar).toHaveCSS(
            "border-radius",
            shape === "squircle" ? "0px" : "50%",
          );
          await expect(avatar).toHaveCSS(
            "mask-image",
            shape === "squircle" ? /^url\(/ : "none",
          );
        }
        await expectInsetArtwork();
        for (const avatar of await system
          .locator("[data-avatar-shape]")
          .all()) {
          const shape = await avatar.getAttribute("data-avatar-shape");
          const paint = await pixels(page, avatar);
          expect(
            paint.center,
            `${mode}/${width}/${shape}: artwork is painted`,
          ).not.toEqual(paint.corner);
          if (shape === "squircle")
            expect(
              paint.shoulder,
              "squircle extends beyond a circle",
            ).not.toEqual(paint.corner);
          else
            expect(paint.shoulder, "human corner stays circular").toEqual(
              paint.corner,
            );
        }
      }
    }
    await page.getByRole("checkbox", { name: "Show pictures" }).uncheck();
    await expect(insetAvatars.locator("img")).toHaveCount(0);
    await expectInsetArtwork(false);
    await page.getByRole("checkbox", { name: "Show pictures" }).check();
    const button = page.getByRole("button", { name: "View Agent profile" });
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await button.hover();
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await button.click();
    await expect(page.getByRole("status")).toHaveText("Profile opened");
    await expect(button).toHaveCSS("outline-style", "none");
    await page.getByRole("button", { name: "Before avatars" }).focus();
    // Safari on macOS uses Option-Tab to include all controls, like the other focus journeys.
    await page.keyboard.press(
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab",
    );
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("outline-style", "solid");
    await expect(button).toHaveCSS("outline-width", "2px");
    await expect(button).toHaveCSS("mask-image", "none");
    await expect(button).toHaveCSS("clip-path", "none");
    await expect(button).toHaveCSS("overflow", "visible");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("Profile opened");
    await page.screenshot({
      path: testInfo.outputPath("avatar-shapes-dark-keyboard.png"),
    });
  } finally {
    await server.close();
  }
});
