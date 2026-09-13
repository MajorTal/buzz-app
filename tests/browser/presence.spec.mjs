import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("presence: viewport demand, equal-status silence, conflict repair and teardown", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await server.listen();
    const started = Date.now();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/presence.html`,
    );
    const timeline = page.getByRole("region", { name: "Presence timeline" });
    await expect(timeline).toBeVisible();
    await expect(
      timeline.locator('[data-presence-status="online"]').first(),
    ).toBeVisible();
    const initial = await page.evaluate(() => ({
      ...window.presenceFixture.report,
      ...window.presenceFixture.diagnostics(),
    }));
    expect(initial.handles).toBe(1);
    expect(initial.authors).toBeGreaterThan(0);
    expect(initial.authors).toBeLessThanOrEqual(20);
    const cohorts = await page.evaluate(() => window.presenceFixture.cohorts);
    expect(initial.currentAuthors.length).toBeGreaterThan(0);
    expect(
      initial.currentAuthors.every((author) => cohorts[0].includes(author)),
    ).toBe(true);
    const onlineDot = timeline
      .locator('[data-presence-status="online"] [data-status]')
      .first();
    await expect(onlineDot).toHaveCSS("border-radius", "50%");
    await expect(onlineDot).toHaveCSS("width", "8px");
    await expect(onlineDot).toHaveCSS("height", "8px");
    const before = initial.notifications;
    await page.evaluate(() => window.presenceFixture.heartbeat(10));
    const renewed = await page.evaluate(() => ({
      ...window.presenceFixture.report,
      ...window.presenceFixture.diagnostics(),
    }));
    expect(renewed.notifications).toBe(before);
    expect(renewed.reads).toBe(initial.reads);
    await page.evaluate(() => {
      window.presenceFixture.status("away");
      window.presenceFixture.heartbeat(1, "away");
    });
    const awayDot = timeline
      .locator('[data-presence-status="away"] [data-status]')
      .first();
    await expect(awayDot).toBeVisible();
    // Test rendered geometry, not just status/ARIA text: Away must not be another circle.
    for (const mode of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.colorMode = value;
      }, mode);
      await expect(awayDot).toHaveCSS("border-radius", "0px");
      await expect(awayDot).toHaveCSS("width", "8px");
      await expect(awayDot).toHaveCSS("height", "8px");
      await testInfo.attach(`away-${mode}.png`, {
        body: await timeline.locator("[data-message-id]").first().screenshot(),
        contentType: "image/png",
      });
    }
    await page.evaluate(() => {
      window.presenceFixture.status("offline");
      window.presenceFixture.heartbeat(1, "offline");
    });
    await expect(
      timeline.locator('[data-presence-status="offline"]').first(),
    ).toBeVisible();
    await page.evaluate(() => window.presenceFixture.heartbeat(1, "online"));
    await expect(
      timeline.locator('[data-presence-status="online"]'),
    ).toHaveCount(0);
    await expect(
      timeline.locator('[data-presence-status="offline"]').first(),
    ).toBeVisible();
    await timeline.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const { report, cohorts } = window.presenceFixture;
          return (
            report.currentAuthors.length > 0 &&
            report.currentAuthors.every((author) => cohorts[1].includes(author))
          );
        }),
      )
      .toBe(true);
    const scrolled = await page.evaluate(
      () => window.presenceFixture.report.currentAuthors,
    );
    expect(
      scrolled.some((author) => initial.currentAuthors.includes(author)),
    ).toBe(false);
    await page.getByRole("button", { name: "Toggle timeline" }).click();
    await expect(timeline).toHaveCount(0);
    const disposed = await page.evaluate(() =>
      window.presenceFixture.diagnostics(),
    );
    expect(disposed.handles).toBe(0);
    expect(disposed.authors).toBe(0);
    await page.getByRole("button", { name: "Toggle timeline" }).click();
    await expect(timeline).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.presenceFixture.diagnostics().handles),
      )
      .toBe(1);
    await testInfo.attach("presence-counters.json", {
      body: JSON.stringify(
        {
          elapsedMs: Date.now() - started,
          initial,
          renewed,
          disposed,
          final: await page.evaluate(() => window.presenceFixture.report),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    await page.evaluate(() => window.presenceFixture.dispose());
  } finally {
    await server.close();
  }
});

test("presence: real same-origin Web Lock and cross-window activity handoff", async ({
  context,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  let first, second;
  try {
    await server.listen();
    first = await context.newPage();
    second = await context.newPage();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/presence-publisher.html`;
    const time = new Date("2026-09-12T00:00:00Z");
    await first.clock.install({ time });
    await second.clock.install({ time });
    await first.goto(url);
    await expect
      .poll(() =>
        first.evaluate(() => window.publisherFixture.diagnostics().leader),
      )
      .toBe(true);
    await first.clock.runFor(1000);
    await second.goto(url);
    await second.clock.runFor(1000);
    expect(
      await first.evaluate(() => window.publisherFixture.publications),
    ).toEqual(["online"]);
    expect(
      await second.evaluate(() => window.publisherFixture.publications),
    ).toEqual([]);
    expect(
      await second.evaluate(
        () => window.publisherFixture.diagnostics().coordinated,
      ),
    ).toBe(true);
    // Timer suspension is lossy, not 600 seconds of catch-up renewals.
    await first.clock.fastForward(600000);
    await second.clock.fastForward(600000);
    await expect
      .poll(() => first.evaluate(() => window.publisherFixture.state().status))
      .toBe("away");
    await second.getByRole("button", { name: "Activity" }).click();
    await expect
      .poll(() => first.evaluate(() => window.publisherFixture.state().status))
      .toBe("online");
    await first.clock.runFor(1000);
    expect(
      await first.evaluate(() => window.publisherFixture.publications.length),
    ).toBeLessThanOrEqual(4);
    expect(
      await second.evaluate(() => window.publisherFixture.publications),
    ).toEqual([]);
    await first.evaluate(() => window.publisherFixture.dispose());
    await expect
      .poll(() =>
        second.evaluate(() => window.publisherFixture.diagnostics().leader),
      )
      .toBe(true);
    await second.clock.runFor(1000);
    expect(
      await second.evaluate(() => window.publisherFixture.publications),
    ).toEqual(["online"]);
  } finally {
    try {
      await Promise.all([first?.close(), second?.close()]);
    } finally {
      await server.close();
    }
  }
});
