import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
test.use({
  productionBroker: true,
  historyCounts: { alpha: 1, beta: 1 },
});
test("clean pending setup stays in diagnostics and never flashes a warning during channel switches", async ({
  page,
  app,
}) => {
  app.relay.holdEose("beta");
  await page.goto(app.origin);
  await page.evaluate(() => {
    window.__bannerSeen = [];
    window.__bannerObserver = new MutationObserver(() => {
      for (const status of document.querySelectorAll(".buzz-toast")) {
        if (
          status.textContent.includes(
            "Only currently accessible messages remain readable.",
          )
        )
          window.__bannerSeen.push(status.textContent);
      }
    });
    window.__bannerObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });

  await openPage(page, "Messages");
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  const warning = page
    .getByRole("dialog", { name: "Live updates need attention", exact: true })
    .filter({ hasText: "Only currently accessible messages remain readable." });
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  await expect(warning).toHaveCount(0);
  const streams = () =>
    app.report.brokerRequests.filter((r) => r.url.endsWith("/stream")).length;
  const before = streams();
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await expect(warning).toHaveCount(0);
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  await openDiagnostics(page);
  await expect(
    page.getByText("Live updates: connecting", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  expect(app.relay.rejected).toHaveLength(0);
  expect(app.report.wireFrames.filter((f) => f[0] === "CLOSED")).toHaveLength(
    0,
  );
  expect(streams()).toBe(before);
  app.relay.releaseEose("beta");
  await expect(warning).toHaveCount(0);
  for (const channel of ["Alpha", "Beta", "Alpha", "Beta"]) {
    await page.getByRole("button", { name: channel, exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: `Message #${channel}`, exact: true }),
    ).toBeVisible();
  }
  const warm = await page.evaluate(() => {
    window.__bannerObserver.disconnect();
    return window.__bannerSeen;
  });
  expect(warm).toEqual([]);
  expect(streams()).toBe(before);
  app.report.measurements.push({
    rejected: app.relay.rejected,
    warmSwitchWarnings: warm,
    streamsBefore: before,
    streamsAfter: streams(),
  });
});

for (const target of ["alpha", "profiles"]) {
  test(`quota recovery for ${target} stays quiet until attempts exhaust, and manual recovery waits for EOSE`, async ({
    page,
    app,
  }, testInfo) => {
    if (target === "profiles")
      await page.addInitScript(() =>
        localStorage.setItem("buzz-appearance.v1", "dark"),
      );
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await expect.poll(() => app.relay.hasRoute("primary", target)).toBe(true);
    const warning = page
      .getByRole("dialog", { name: "Live updates need attention", exact: true })
      .filter({
        hasText: "Only currently accessible messages remain readable.",
      });
    await expect(warning).toHaveCount(0);
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    await openDiagnostics(page);
    const recovery = page.getByText(
      "Live updates: recovering automatically after rate limiting; awaiting confirmation",
      { exact: true },
    );
    const rejected = "rate-limited: quota exceeded; retry in 0s";
    app.relay.holdEose(target);
    const requests = () =>
      app.relay.requests.filter(
        (r) => r.community === "primary" && r.routes.includes(target),
      );
    const streams = () =>
      app.report.brokerRequests.filter((r) => r.url.endsWith("/stream")).length;
    const streamCount = streams();
    const sockets = app.relay.sockets.length;
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = requests().length;
      app.relay.failRoute("primary", target, rejected);
      if (attempt < 3) {
        await expect(recovery).toBeVisible();
        await expect(warning).toHaveCount(0);
        await expect.poll(() => requests().length).toBeGreaterThan(before);
        // The new REQ exists, but fixture holds EOSE: no false healthy status.
        await expect(recovery).toBeVisible();
        await expect(warning).toHaveCount(0);
      } else {
        await expect(warning).toBeVisible();
        await expect(warning).toContainText("recovery needs attention");
        await expect(warning).not.toContainText("retry in 0s");
      }
    }
    // Persistent feedback must not block the header, composer, or narrow navigation.
    for (const width of [390, 800, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await page
        .getByRole("button", {
          name: "Close Channel settings tab",
          exact: true,
        })
        .click();
      await page
        .getByRole("textbox", { name: "Message #Alpha", exact: true })
        .fill("Unsent recovery draft");
      await expect(warning).toHaveCount(1); // Diagnostics must not emit a second toast.
      await expect(warning).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: testInfo.outputPath(`toast-app-${target}-${width}.png`),
      });
      await page
        .getByRole("button", { name: "Channel settings", exact: true })
        .click();
      await openDiagnostics(page);
      await expect(warning).toHaveCount(1);
    }
    const beforeManual = requests().length;
    await page
      .getByRole("button", { name: "Close Channel settings tab", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Retry live updates", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Channel settings", exact: true })
      .click();
    await openDiagnostics(page);
    await expect(recovery).toBeVisible();
    await expect(warning).toHaveCount(0);
    await expect.poll(() => requests().length).toBeGreaterThan(beforeManual);
    await expect(recovery).toBeVisible();
    app.relay.releaseEose(target);
    await expect(recovery).toHaveCount(0);
    await expect(
      page.getByText("Live updates: stream established", { exact: true }),
    ).toBeVisible();
    await expect(warning).toHaveCount(0);
    expect(streams()).toBe(streamCount);
    expect(app.relay.sockets).toHaveLength(sockets);
  });
}

async function openDiagnostics(page) {
  // A quick reopen can retain the outgoing settings DOM during its exit.
  const summary = page.getByText("Diagnostics", { exact: true });
  if ((await summary.locator("..").getAttribute("open")) === null)
    await summary.click();
  await expect(summary.locator("..")).toHaveAttribute("open", "");
}
