import { test, expect } from "./fixture.mjs";
test.use({ productionBroker: true });
test("clean pending setup stays in diagnostics and never flashes a warning during channel switches", async ({
  page,
  app,
}) => {
  app.relay.holdEose("beta");
  await page.goto(app.origin);
  await page.evaluate(() => {
    window.__bannerSeen = [];
    window.__bannerObserver = new MutationObserver(() => {
      for (const status of document.querySelectorAll('[role="status"]')) {
        if (status.textContent.includes("Retained messages remain readable."))
          window.__bannerSeen.push(status.textContent);
      }
    });
    window.__bannerObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });

  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  const warning = page
    .getByRole("status")
    .filter({ hasText: "Retained messages remain readable." });
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
  await page.getByLabel("Conversation options", { exact: true }).click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await expect(
    page.getByText("Live updates: connecting", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Conversation options", { exact: true }).click();
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
  }) => {
    await page.goto(app.origin);
    await page
      .getByRole("button", { name: "Messages", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await expect.poll(() => app.relay.hasRoute("primary", target)).toBe(true);
    const warning = page
      .getByRole("status")
      .filter({ hasText: "Retained messages remain readable." });
    await expect(warning).toHaveCount(0);
    await page.getByLabel("Conversation options", { exact: true }).click();
    await page.getByText("Diagnostics", { exact: true }).click();
    const recovery = page.getByText(
      "Live updates: recovering automatically after rate limiting; awaiting confirmation",
      { exact: true },
    );
    const rejected = "rate-limited: quota exceeded; retry in 0s";
    app.relay.holdEose(target);
    const requests = () =>
      app.relay.requests.filter(
        (r) => r.community === "primary" && r.route === target,
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
    const beforeManual = requests().length;
    await page.getByLabel("Conversation options", { exact: true }).click();
    await page
      .getByRole("button", { name: "Retry live updates", exact: true })
      .click();
    await page.getByLabel("Conversation options", { exact: true }).click();
    // The inner Diagnostics details retains its open state when its parent closes.
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
