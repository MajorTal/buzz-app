import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
test.use({ productionBroker: true, developmentReact: true });

test("activity launcher consumes real encrypted telemetry, escapes raw text, selects agents, and releases on disable", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const launcher = page.getByRole("button", {
    name: "Agent Activity",
    exact: true,
  });
  await expect(launcher).toBeVisible();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  await launcher.click();
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel.getByText(/Waiting for live records/)).toBeVisible();
  const first = generateSecretKey(),
    second = generateSecretKey();
  const raw = {
    kind: "turn_liveness",
    seq: 1,
    timestamp: new Date().toISOString(),
    channelId: "alpha",
    sessionId: "S",
    turnId: "one",
    payload: { text: '<img src=x onerror="window.telemetryExecuted=true">' },
  };
  const result = app.observer(raw, first);
  const disclosure = panel.getByRole("button", { name: /turn_liveness/ });
  await expect(disclosure).toBeVisible();
  await expect(panel.getByText("1 observed working turn(s).")).toBeVisible();
  await disclosure.focus();
  await disclosure.press("Enter");
  await expect(panel.locator("pre code")).toHaveText(result.plaintext);
  expect(await page.evaluate(() => window.telemetryExecuted)).toBeUndefined();
  await disclosure.press("Space");
  await expect(panel.locator("pre code")).not.toBeVisible();
  app.observer({ ...raw, kind: "turn_completed", sessionId: null }, first);
  await expect(panel.getByText("No fresh working evidence.")).toBeVisible();
  app.observer({ ...raw, turnId: "two", kind: "acp_read" }, second);
  await panel.getByRole("combobox", { name: "Agent" }).click();
  await page
    .getByRole("option", {
      name: new RegExp(getPublicKey(second).slice(0, 12)),
    })
    .click();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /turn_completed/ }),
  ).toHaveCount(0);
  const sockets = app.relay.sockets.length;
  await launcher.click();
  await launcher.click();
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const toggle = page.getByRole("switch", {
    name: "Enable Agent Activity",
    exact: true,
  });
  await toggle.click();
  await expect(launcher).toHaveCount(0);
  await expect
    .poll(() => app.relay.hasRoute("primary", "observer"))
    .toBe(false);
  expect(app.relay.sockets).toHaveLength(sockets);
  await toggle.click();
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(panel.getByText(/Waiting for live records/)).toBeVisible();
});

for (const mode of ["light", "dark"]) {
  test(`activity raw disclosure fits wide and narrow layouts in ${mode}`, async ({
    page,
    app,
  }, testInfo) => {
    await page.addInitScript((mode) => {
      localStorage.setItem("buzz-appearance.v1", mode);
    }, mode);
    await page.goto(app.origin);
    await page
      .getByRole("button", { name: "Agent Activity", exact: true })
      .click();
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    app.observer(
      {
        kind: "acp_read",
        turnId: "layout",
        channelId: "alpha",
        sessionId: null,
        timestamp: new Date().toISOString(),
        payload: { text: "A long literal raw record. ".repeat(40) },
      },
      generateSecretKey(),
    );
    const panel = page.getByRole("region", {
      name: "Agent activity",
      exact: true,
    });
    await panel.getByRole("button", { name: /acp_read/ }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel.locator("pre code")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(`activity-${mode}-${width}.png`),
      });
    }
  });
}

test("profile activity opens the exact agent and originating channel before its first frame", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const agentKey = generateSecretKey();
  const agent = getPublicKey(agentKey);
  const message = finalizeEvent(
    {
      kind: 9,
      tags: [["h", "alpha"]],
      content: "Contextual agent entry",
      created_at: Math.floor(Date.now() / 1000),
    },
    agentKey,
  );
  app.relay.publish("primary", message);
  const avatar = page
    .locator(`[data-message-id="${message.id}"]`)
    .getByRole("button", { name: /profile/ });
  await avatar.click();
  const profile = page.getByRole("complementary", {
    name: "Profile",
    exact: true,
  });
  await profile
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  await expect(profile).toHaveCount(0);
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel.locator("code").first()).toHaveText(agent);
  await expect(
    panel.getByRole("combobox", { name: "Channel", exact: true }),
  ).toHaveText(/Alpha.*alpha/);
  await expect(
    panel.getByText(
      /Waiting for live records for this identity in this channel/,
    ),
  ).toBeVisible();
  const item = (kind, channelId, turnId) => ({
    kind,
    channelId,
    turnId,
    sessionId: null,
    timestamp: new Date().toISOString(),
  });
  app.observer(item("acp_read", "alpha", "other-agent"), generateSecretKey());
  app.observer(item("acp_write", "beta", "other-channel"), agentKey);
  app.observer(item("session_resolved", null, "unscoped"), agentKey);
  const expected = app.observer(
    item("turn_liveness", "alpha", "wanted"),
    agentKey,
  );
  const row = panel.getByRole("button", { name: /turn_liveness/ });
  await expect(row).toBeVisible();
  await expect(panel.getByText("1 observed working turn(s).")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /acp_read|acp_write|session_resolved/ }),
  ).toHaveCount(0);
  await row.click();
  await expect(panel.locator("pre code")).toHaveText(expected.plaintext);
  await panel.getByRole("combobox", { name: "Channel", exact: true }).click();
  await page
    .getByRole("option", {
      name: "All channels (including unscoped records)",
      exact: true,
    })
    .click();
  await expect(panel.getByRole("button", { name: /acp_write/ })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /session_resolved/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  await panel.press("Escape");
  await expect(avatar).toBeFocused();
  await avatar.click();
  await profile
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  await page.locator('[data-channel-id="beta"]').click();
  await expect(panel).toHaveCount(0);
  // Disable removes both registration and profile affordance, not the profile itself.
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Agent Activity", exact: true })
    .click();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.locator('[data-channel-id="alpha"]').click();
  await avatar.click();
  await expect(profile).toBeVisible();
  await expect(
    profile.getByRole("button", { name: "View activity", exact: true }),
  ).toHaveCount(0);
});
