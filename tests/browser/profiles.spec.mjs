import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("profile plumbing: exact avatar/mention targets, thread enrichment, lifecycle and recovery", async ({
  page,
}, testInfo) => {
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
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/profiles.html`,
    );
    const panel = page.getByRole("complementary", {
      name: "Profile",
      exact: true,
    });
    await page.waitForFunction(() => !!window.profilesFixture);
    const npubs = await page.evaluate(() => window.profilesFixture.npubs);
    const key = page
      .getByRole("complementary", { name: "Profile", exact: true })
      .locator("code");
    const avatar = page.getByRole("button", {
      name: "View Viewer profile",
      exact: true,
    });
    await expect(avatar).toHaveCount(1);
    await avatar.focus();
    await avatar.press("Enter");
    await expect(key).toHaveText(npubs.viewer);
    const portrait = panel.getByRole("img", { name: "Viewer avatar" });
    await expect(portrait).toBeVisible();
    const name = panel.getByRole("heading", { name: "Viewer", exact: true });
    const portraitWidth = await portrait.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    const contentWidth = await portrait.evaluate((element) => {
      const region = element.closest('[aria-label="Profile details"]');
      return (
        region.clientWidth -
        parseFloat(getComputedStyle(region).paddingLeft) -
        parseFloat(getComputedStyle(region).paddingRight)
      );
    });
    const maxPortraitWidth = await page.evaluate(() =>
      Math.min(256, innerHeight * 0.35),
    );
    expect(portraitWidth).toBeCloseTo(
      Math.min(contentWidth, maxPortraitWidth),
      0,
    );
    expect(
      await portrait.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    ).toBeCloseTo(portraitWidth, 0);
    expect(
      await name.evaluate(
        (element, portrait) =>
          element.getBoundingClientRect().top >=
          portrait.getBoundingClientRect().bottom,
        await portrait.elementHandle(),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => window.profilesFixture.report.media),
    ).toContainEqual(["https://images.test/avatar.png", undefined]);
    await expect(
      panel.getByText("Human profile", { exact: true }),
    ).toBeVisible();
    // Stub clipboard at the browser boundary: test the UI's exact key and
    // recovery, without relying on OS permission/pasteboard behavior in CI.
    await page.evaluate(() => {
      window.profileCopies = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value) => window.profileCopies.push(value) },
      });
    });
    await panel.getByRole("button", { name: "Copy npub" }).click();
    await expect(panel.getByRole("status")).toHaveText("Public key copied.");
    expect(await page.evaluate(() => window.profileCopies)).toEqual([
      npubs.viewer,
    ]);
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error("denied");
      };
    });
    await panel.getByRole("button", { name: "Copy npub" }).click();
    await expect(panel.getByRole("status")).toHaveText(
      "Could not copy. Select the public key above to copy it.",
    );
    await expect(key).toHaveText(npubs.viewer);
    await page.getByRole("region", { name: "Profile details" }).press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(avatar).toBeFocused();
    const mention = page.getByRole("button", {
      name: "View Mic profile",
      exact: true,
    });
    await mention.click();
    await expect(key).toHaveText(npubs.mic);
    await panel.getByRole("button", { name: "Close channel panel" }).click();
    await expect(mention).toBeFocused();
    await mention.press("Space");
    await expect(key).toHaveText(npubs.mic);
    await page.evaluate(() =>
      window.profilesFixture.change("disable", "buzz.profiles"),
    );
    await expect(panel).toHaveCount(0);
    await expect(mention).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Channel message history" })
        .getByText("Hello @Mic", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.profilesFixture.change("enable", "buzz.profiles"),
    );
    await expect(mention).toHaveCount(1);
    await expect(panel).toHaveCount(0);
    await page
      .getByRole("button", { name: "View thread: 1 reply", exact: true })
      .click();
    const threadMention = page.getByRole("button", {
      name: "View Pinky profile",
      exact: true,
    });
    await expect(threadMention).toBeVisible();
    await threadMention.click();
    await expect(key).toHaveText(npubs.pinky);
    await expect(
      panel.getByText("Agent profile", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Close channel panel" }).click();
    await expect(
      page.getByRole("button", { name: "View thread: 1 reply", exact: true }),
    ).toBeFocused();
    const missingKey = await page.evaluate(
      () => window.profilesFixture.keys.missing,
    );
    await page
      .getByRole("button", { name: `View ${missingKey.slice(0, 10)} profile` })
      .click();
    await expect(key).toHaveText(npubs.missing);
    await expect(panel.getByText("Could not load this profile.")).toBeVisible();
    await page.evaluate(() => window.profilesFixture.recover());
    await panel.getByRole("button", { name: "Retry profile" }).click();
    await expect(panel.getByText("Recovered biography")).toBeVisible();
    for (const mode of ["light", "dark"]) {
      if (mode === "dark")
        await page.getByRole("button", { name: "Toggle appearance" }).click();
      for (const width of [1280, 900, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(key).toBeVisible();
        const layout = await panel.evaluate((element) => {
          const region = element.querySelector(
            '[aria-label="Profile details"]',
          );
          const key = element.querySelector("code");
          return {
            padding: parseFloat(getComputedStyle(region).paddingLeft),
            overflow: element.scrollWidth > element.clientWidth,
            keyOverflow: key.scrollWidth > key.clientWidth,
          };
        });
        expect(layout.padding).toBeGreaterThanOrEqual(16);
        expect(layout.overflow).toBe(false);
        expect(layout.keyOverflow).toBe(false);
        await panel.screenshot({
          path: testInfo.outputPath(`profile-${mode}-${width}.png`),
        });
      }
    }
    await page.evaluate(() => window.profilesFixture.replace());
    await expect(panel).toHaveCount(0);
    const reads = await page.evaluate(() => ({
      reads: window.profilesFixture.report.profileReads,
      key: window.profilesFixture.keys.pinky,
    }));
    expect(reads.reads.some((batch) => batch.includes(reads.key))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

test("contextual panel callbacks retire with opening, channel, contribution and session", async ({
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
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/profiles.html?context-probe`,
    );
    const avatar = page.getByRole("button", {
      name: "View Viewer profile",
      exact: true,
    });
    const panel = page.getByRole("complementary", {
      name: "Context probe",
      exact: true,
    });
    const capture = async () => {
      await avatar.click();
      await expect(panel).toBeVisible();
      await page.evaluate(() => {
        window.oldPanelContext = window.profilesFixture.contexts.at(-1);
      });
    };
    const invoke = () =>
      page.evaluate(() =>
        window.oldPanelContext.open(window.profilesFixture.targets.mic),
      );
    await capture();
    expect(await page.evaluate(() => window.oldPanelContext.channelId)).toBe(
      "one",
    );
    expect(await invoke()).toBe(true);
    // A second synchronous use of the old opening must not replace its successor.
    expect(await invoke()).toBe(false);
    await panel.getByRole("button", { name: "Close channel panel" }).click();
    await capture();
    await page.locator('[data-channel-id="two"]').click();
    await expect(panel).toHaveCount(0);
    expect(await invoke()).toBe(false);
    await page.locator('[data-channel-id="one"]').click();
    await capture();
    await page.evaluate(() =>
      window.profilesFixture.change("disable", "context.probe"),
    );
    expect(await invoke()).toBe(false);
    await expect(panel).toHaveCount(0);
    await page.evaluate(() =>
      window.profilesFixture.change("enable", "context.probe"),
    );
    await expect(avatar).toBeVisible();
    expect(await invoke()).toBe(false);
    await capture();
    await page.evaluate(() => window.profilesFixture.replace());
    expect(await invoke()).toBe(false);
    await expect(panel).toHaveCount(0);
    await capture();
    await page.evaluate(() => window.profilesFixture.disconnect());
    expect(await invoke()).toBe(false);
    await expect(panel).toHaveCount(0);
  } finally {
    await server.close();
  }
});
