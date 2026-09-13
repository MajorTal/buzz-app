import { expect, test } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("shared avatars defer offscreen artwork, omit the referrer and recover from failure", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    const requests = [];
    await page.route("https://images.example/avatar.png", async (route) => {
      requests.push(route.request().headers());
      await route.fulfill({
        path: fileURLToPath(
          new URL(
            "../fixtures/design-system/assets/avatar.png",
            import.meta.url,
          ),
        ),
        contentType: "image/png",
      });
    });
    const port = server.httpServer.address().port;
    await page.goto(
      `http://127.0.0.1:${port}/tests/fixtures/agents.html?external-avatar&offscreen-avatar`,
    );
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).not.toBeInViewport();
    await page.waitForTimeout(300);
    expect(requests).toHaveLength(0);
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).toBeInViewport();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].referer).toBeUndefined();

    const avatar = page
      .getByRole("article")
      .filter({
        has: page.getByRole("button", { name: "A Brain: 2 identities" }),
      })
      .getByRole("img", { name: "A Brain", exact: true });
    const image = avatar.locator("img");
    await expect
      .poll(() => image.evaluate((el) => el.naturalWidth))
      .toBeGreaterThan(0);
    await expect(image).toHaveCSS("opacity", "1");
    await expect(avatar).toHaveText("");
    const original = await avatar.boundingBox();

    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("https://images.example/failure.png", async (route) => {
      await held;
      await route.abort();
    });
    await page.evaluate(() =>
      window.agentFixture.setArtwork("https://images.example/failure.png"),
    );
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(avatar).toContainText("A");
    await expect(image).toHaveCSS("opacity", "0");
    expect(await avatar.boundingBox()).toEqual(original);
    release();
    await expect(avatar).toContainText("A");
    await expect(avatar.locator("img")).toHaveCount(0);
    await page.evaluate(() =>
      window.agentFixture.setArtwork("https://images.example/avatar.png"),
    );
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect
      .poll(() => image.evaluate((el) => el.naturalWidth))
      .toBeGreaterThan(0);
    await expect(image).toHaveCSS("opacity", "1");
    await expect(avatar).toHaveText("");
  } finally {
    await server.close();
  }
});
