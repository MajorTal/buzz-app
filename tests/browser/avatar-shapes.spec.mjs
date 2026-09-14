import { expect, test } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Sample actual browser paint, not just shape attributes or bounding boxes.
async function pixels(page, locator) {
  const png = await locator.screenshot();
  return page.evaluate(async (base64) => {
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
        Math.floor(image.width * fraction),
        Math.floor(image.height * fraction),
        1,
        1,
      ).data,
    ];
    return { corner: at(0), shoulder: at(0.1), center: at(0.5) };
  }, png.toString("base64"));
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
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/avatar-shapes.html`,
    );
    const avatars = page.locator("[data-avatar-shape]");
    await expect(avatars).toHaveCount(12);
    for (const image of await avatars.locator("img").all()) {
      await expect
        .poll(() => image.evaluate((el) => el.complete && el.naturalWidth > 0))
        .toBe(true);
      await expect(image).toHaveCSS("opacity", "1");
    }
    const system = page.getByRole("region", { name: "System avatars" });
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
