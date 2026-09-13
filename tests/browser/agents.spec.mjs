import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("My agents reads the existing library with exact linked keys and session-safe retries", async ({
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agents.html`,
    );
    const agents = page.getByRole("region", {
      name: "My agents",
      exact: true,
    });
    await expect(
      agents.getByRole("heading", { name: "A Brain", exact: true }),
    ).toHaveCount(2);
    const keys = await page.evaluate(() => window.agentFixture.agents);
    await expect
      .poll(() => agents.locator("img").evaluate((image) => image.naturalWidth))
      .toBeGreaterThan(0);
    await expect(agents.locator("img")).toHaveCSS("opacity", "1");
    await expect(
      agents.getByRole("img", { name: "A Brain", exact: true }),
    ).toHaveCount(2);

    for (const key of keys)
      await expect(agents.getByText(key, { exact: true })).toBeHidden();
    await agents
      .getByRole("button", { name: "A Brain: 2 identities", exact: true })
      .click();
    for (const key of keys)
      await expect(agents.getByText(key, { exact: true })).toBeVisible();
    await expect(
      page.getByText(/current Buzz library, read-only/),
    ).toBeVisible();
    const surface = page.getByRole("region", { name: "Agents", exact: true });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      for (const width of [390, 800, 1600]) {
        await page.setViewportSize({ width, height: 400 });
        const frame = await page.locator("main").boundingBox();
        const bounds = await surface.boundingBox();
        expect(frame).not.toBeNull();
        expect(bounds).not.toBeNull();
        expect(Math.abs(frame.width - bounds.width)).toBeLessThan(2);
        expect(Math.abs(frame.height - bounds.height)).toBeLessThan(2);
        await expect(surface).toHaveCSS("overflow", "hidden");
        expect(
          await surface.evaluate((el) => {
            const style = getComputedStyle(el);
            const probe = document.createElement("div");
            probe.style.cssText =
              "background:var(--bg-panel);border-radius:var(--radius-panel);border:1px solid var(--border-primary);box-shadow:var(--shadow-xs)";
            el.append(probe);
            const reference = getComputedStyle(probe);
            const matches = [
              "backgroundColor",
              "borderRadius",
              "borderTopColor",
              "boxShadow",
            ].every((key) => style[key] === reference[key]);
            probe.remove();
            return matches;
          }),
        ).toBe(true);
        const scroller = surface.locator(":scope > div");
        const documentTop = await page.evaluate(
          () => document.scrollingElement.scrollTop,
        );
        await scroller.evaluate((el) => {
          el.scrollTop = 0;
        });
        expect(
          await scroller.evaluate((el) => el.scrollHeight > el.clientHeight),
        ).toBe(true);
        await scroller.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(
          0,
        );
        await expect(
          surface.getByText(/current Buzz library, read-only/),
        ).toBeInViewport();
        expect(await surface.evaluate((el) => el.scrollTop)).toBe(0);
        expect(
          await page.evaluate(() => document.scrollingElement.scrollTop),
        ).toBe(documentTop);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
      }
    }
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.screenshot({
      path: test.info().outputPath("my-agents.png"),
    });
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    expect(
      await page
        .getByRole("region", { name: "Agents", exact: true })
        .evaluate((el) => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = "var(--bg-panel)";
          el.append(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return getComputedStyle(el).backgroundColor === expected;
        }),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("my-agents-dark.png"),
    });
    await page
      .getByRole("button", { name: "Toggle empty", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(
      page.getByText("No selected agents in your Buzz library."),
    ).toBeVisible();
    await expect(agents.getByRole("article")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle empty", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Toggle error", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(page.getByRole("alert").first()).toContainText(
      "Could not read",
    );
    await page
      .getByRole("button", { name: "Toggle error", exact: true })
      .click();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(agents.getByRole("article")).toHaveCount(2);
    await page
      .getByRole("button", { name: "Toggle archive", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(agents.getByRole("article")).toHaveCount(2);
    await expect(agents.getByText(keys[0], { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle archive", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Toggle missing archive", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(agents.getByRole("article")).toHaveCount(2);
    await agents
      .getByRole("button", { name: "A Brain: 2 identities", exact: true })
      .click();
    for (const key of keys)
      await expect(agents.getByText(key, { exact: true })).toBeVisible();
    await expect(page.getByText(/Archive visibility is unknown/)).toBeVisible();
    await page
      .getByRole("button", { name: "Toggle missing archive", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(page.getByText(/Archive visibility is unknown/)).toHaveCount(
      0,
    );
    const reads = await page.evaluate(() => window.agentFixture.reads());
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await expect(agents.getByRole("article")).toHaveCount(2);
    expect(await page.evaluate(() => window.agentFixture.reads())).toBe(
      reads + 2,
    );
    await page
      .getByRole("button", { name: "Toggle hold", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh agents", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText(
      "Reading your Buzz library…",
    );
    await page
      .getByRole("button", { name: "Community B", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Release reads", exact: true })
      .click();
    await expect(
      agents.getByRole("heading", { name: "B Brain", exact: true }),
    ).toHaveCount(2);
    await expect(page.getByText("A Brain", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Community A", exact: true })
      .click();
    await expect(
      agents.getByRole("heading", { name: "A Brain", exact: true }),
    ).toHaveCount(2);
    await page
      .getByRole("button", { name: "Clear cache", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Library cleared");
    await expect(page.getByRole("article")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
