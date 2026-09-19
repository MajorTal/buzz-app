import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
test.use({ productionBroker: true, developmentReact: true });

const channelActivity = (page) =>
  page.getByRole("region", {
    name: "Agent activity in this channel",
    exact: true,
  });
const agentEntry = (page, agent) =>
  channelActivity(page).getByRole("button", {
    name: new RegExp(`^View activity for .+ ${agent.slice(0, 12)}$`),
  });
const activityPanel = (page) =>
  page.getByRole("region", { name: "Agent activity", exact: true });
const activity = (kind, channelId, turnId, payload) => ({
  kind,
  seq: 1,
  timestamp: new Date().toISOString(),
  channelId,
  sessionId: "S",
  turnId,
  ...(payload === undefined ? {} : { payload }),
});

// The composer entry is the only channel launcher. Profile activity remains the
// durable fallback after fresh working evidence disappears (covered below).
test("channel activity consumes telemetry, isolates mixed batches, selects agents, and resets on disable", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect(
    page.getByRole("button", { name: "Agent Activity", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const firstKey = generateSecretKey();
  const secondKey = generateSecretKey();
  const first = getPublicKey(firstKey);
  const second = getPublicKey(secondKey);
  const unsafe = app.observer(
    activity("turn_liveness", "alpha", "one", {
      text: '<img src=x onerror="window.telemetryExecuted=true">',
    }),
    firstKey,
  );
  app.observer(activity("turn_liveness", "alpha", "two"), secondKey);
  app.observer(
    {
      kind: "batch",
      timestamp: new Date().toISOString(),
      channelId: "alpha",
      payload: {
        events: [
          activity("acp_read", "alpha", "one", "wanted child"),
          activity("acp_write", "beta", "other-channel", "other channel"),
        ],
      },
    },
    firstKey,
  );

  const region = channelActivity(page);
  await expect(region).toBeVisible();
  const firstEntry = agentEntry(page, first);
  const secondEntry = agentEntry(page, second);
  await expect(firstEntry).toBeVisible();
  await expect(firstEntry).toContainText("working");
  await expect(secondEntry).toBeVisible();
  await expect(region).toHaveCSS("border-top-width", "0px");
  await expect(region).toHaveCSS("border-right-width", "0px");
  await expect(region).toHaveCSS("border-bottom-width", "0px");
  await expect(region).toHaveCSS("border-left-width", "0px");
  const workingIndicator = firstEntry.locator("svg[data-working]");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(workingIndicator).not.toHaveCSS("animation-name", "none");
  await expect(workingIndicator).toHaveCSS("animation-duration", "1.4s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(workingIndicator).toHaveCSS("animation-name", "none");
  await expect(firstEntry).toContainText("working");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await firstEntry.hover();
  const tooltip = page.getByRole("tooltip").filter({ hasText: first });
  await expect(tooltip).toContainText(
    "1 working turn(s) in this channel, including threads.",
  );
  await expect(tooltip).toContainText(
    "Owner-only activity. Select to inspect.",
  );
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(0, 0);
  // Establish a starting point, then leave and re-enter using actual keyboard
  // input. focus() alone neither clears Escape dismissal nor proves :focus-visible.
  await firstEntry.focus();
  await page.keyboard.press("Tab");
  await expect(firstEntry).not.toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(firstEntry).toBeFocused();
  await expect(tooltip).toContainText(first);
  await expect(firstEntry).toHaveAccessibleDescription(/Owner-only activity/);
  await firstEntry.press("Enter");

  const panel = activityPanel(page);
  await expect(panel.locator("code").first()).toHaveText(first);
  await expect(
    panel.getByRole("combobox", { name: "Channel", exact: true }),
  ).toHaveText(/Alpha.*alpha/);
  await expect(panel.getByText("1 observed working turn(s).")).toBeVisible();
  const unsafeDisclosure = panel.getByRole("button", { name: /turn_liveness/ });
  await unsafeDisclosure.focus();
  await unsafeDisclosure.press("Enter");
  await expect(panel.locator("pre code")).toHaveText(unsafe.plaintext);
  expect(await page.evaluate(() => window.telemetryExecuted)).toBeUndefined();
  await unsafeDisclosure.press("Space");
  await expect(panel.locator("pre code")).not.toBeVisible();

  const matchingChild = panel.getByRole("button", { name: /acp_read/ });
  await expect(matchingChild).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_write/ })).toHaveCount(0);
  await matchingChild.click();
  await expect(panel.locator("pre code")).toContainText('"channelId": "alpha"');
  await expect(panel.locator("pre code")).not.toContainText("other channel");

  await page.getByRole("button", { name: "Close channel panel" }).click();
  await expect(firstEntry).toBeFocused();
  await secondEntry.click();
  await expect(panel.locator("code").first()).toHaveText(second);
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close channel panel" }).click();
  await expect(secondEntry).toBeFocused();
  await secondEntry.click();
  await expect(panel.locator("code").first()).toHaveText(second);

  const sockets = app.relay.sockets.length;
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const toggle = page.getByRole("switch", {
    name: "Enable Agent Activity",
    exact: true,
  });
  await toggle.click();
  await expect
    .poll(() => app.relay.hasRoute("primary", "observer"))
    .toBe(false);
  expect(app.relay.sockets).toHaveLength(sockets);
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.locator('[data-channel-id="alpha"]').click();
  await expect(region).toHaveCount(0);

  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await toggle.click();
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  app.observer(activity("turn_liveness", "alpha", "after-reset"), firstKey);
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page.locator('[data-channel-id="alpha"]').click();
  await expect(agentEntry(page, first)).toBeVisible();
  await expect(agentEntry(page, second)).toHaveCount(0);
  await agentEntry(page, first).click();
  await expect(
    panel.getByRole("button", { name: /turn_liveness/ }),
  ).toHaveCount(1);
  await expect(panel.getByRole("button", { name: /acp_read/ })).toHaveCount(0);

  // Stale evidence is unknown, not completed; one terminal turn must not hide
  // another active turn for the same agent. Capture survives closing the panel.
  await page.getByRole("button", { name: "Close channel panel" }).click();
  app.observer(activity("turn_completed", "alpha", "after-reset"), firstKey);
  await expect(agentEntry(page, first)).toHaveCount(0);
  app.observer(
    {
      ...activity("turn_liveness", "alpha", "stale"),
      timestamp: new Date(Date.now() - 31_000).toISOString(),
    },
    firstKey,
  );
  await expect(agentEntry(page, first)).toContainText("status unknown");
  await expect(agentEntry(page, first).locator("svg")).toHaveCSS(
    "animation-name",
    "none",
  );
  app.observer(activity("turn_liveness", "alpha", "fresh"), firstKey);
  await expect(agentEntry(page, first)).toContainText("working");
  app.observer(activity("turn_completed", "alpha", "fresh"), firstKey);
  await expect(agentEntry(page, first)).toContainText("status unknown");
  app.observer(activity("turn_completed", "alpha", "stale"), firstKey);
  await expect(region).toHaveCount(0);
});

for (const mode of ["light", "dark"]) {
  test(`channel activity entry and raw disclosure fit wide and narrow layouts in ${mode}`, async ({
    page,
    app,
  }, testInfo) => {
    await page.addInitScript((mode) => {
      localStorage.setItem("buzz-appearance.v1", mode);
    }, mode);
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const agentKey = generateSecretKey();
    const agent = getPublicKey(agentKey);
    const secondKey = generateSecretKey();
    app.observer(
      activity("turn_liveness", "alpha", "second-layout"),
      secondKey,
    );
    app.observer(
      activity("acp_read", "alpha", "layout", {
        text: "A long literal raw record. ".repeat(40),
      }),
      agentKey,
    );
    const entry = agentEntry(page, agent);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(entry).toBeVisible();
      const entryBox = await entry.boundingBox();
      const formBox = await page
        .getByRole("form", { name: "Send a message to Alpha", exact: true })
        .boundingBox();
      expect(entryBox.y + entryBox.height).toBeLessThanOrEqual(formBox.y);
      const avatarBox = await entry.locator(".buzz-avatar").boundingBox();
      expect(avatarBox.x).toBeCloseTo(formBox.x, 0);
      const lastRow = await channelActivity(page)
        .getByRole("button")
        .last()
        .boundingBox();
      expect(formBox.y - lastRow.y - lastRow.height).toBeCloseTo(4, 0);
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      // Escape suppresses hover until the pointer leaves the trigger. A viewport
      // resize can keep WebKit's pointer over it, so make the next entry explicit.
      await page.mouse.move(0, 0);
      await entry.hover();
      await expect(page.getByRole("tooltip")).toContainText(
        "in this channel, including threads.",
      );
      await page.screenshot({
        path: testInfo.outputPath(`activity-entry-${mode}-${width}.png`),
      });
      await page.keyboard.press("Escape");
    }

    await entry.click();
    const panel = activityPanel(page);
    await panel.getByRole("button", { name: /acp_read/ }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel.locator("pre code")).toBeVisible();
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

test.describe("thread activity", () => {
  test.use({ threadUnread: true, readState: true });

  test("thread typing uses the existing route, stays isolated, and opens channel details above the composer", async ({
    page,
    app,
  }, testInfo) => {
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    const key = generateSecretKey(),
      agent = getPublicKey(key);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content.startsWith("Thread root"));
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${root.id}"]`,
    );
    await row.hover();
    await row.getByRole("button", { name: /^View thread:/ }).click();
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    await expect(
      thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
    ).toBeVisible();
    const region = thread.getByRole("region", {
      name: "Agent activity in this thread",
      exact: true,
    });
    const marker = page
      .locator('[data-channel-id="alpha"]')
      .getByRole("img", { name: "Agent working", exact: true });
    const sendTyping = (threadId, signingKey = key, secondsAgo = 0) => {
      const event = finalizeEvent(
        {
          kind: 20002,
          created_at: Math.floor(Date.now() / 1000) - secondsAgo,
          content: "",
          tags: [
            ["h", "alpha"],
            ...(threadId
              ? [
                  ["e", threadId, "", "root"],
                  ["e", threadId, "", "reply"],
                ]
              : []),
          ],
        },
        signingKey,
      );
      app.relay.publish("primary", event);
      return event;
    };
    // Owner telemetry recognizes the agent without claiming a working channel turn.
    app.observer(activity("turn_liveness", "alpha", "previous"), key);
    await expect(agentEntry(page, agent)).toBeVisible();
    app.observer(activity("turn_completed", "alpha", "previous"), key);
    await expect(agentEntry(page, agent)).toHaveCount(0);
    sendTyping(root.id, generateSecretKey());
    sendTyping("b".repeat(64));
    await expect(region).toHaveCount(0);
    const typing = sendTyping(root.id);
    await expect(region).toBeVisible();
    await expect(marker).toHaveCount(0); // Thread-only fallback must not light channel scope.
    await expect(channelActivity(page)).toHaveCount(0);
    await expect(page.locator(`[data-message-id="${typing.id}"]`)).toHaveCount(
      0,
    );
    const entry = region.getByRole("button", {
      name: new RegExp(agent.slice(0, 12)),
    });
    const form = thread.getByRole("form", {
      name: "Reply to thread",
      exact: true,
    });
    const entryBox = await entry.boundingBox(),
      formBox = await form.boundingBox();
    expect(entryBox.y + entryBox.height).toBeLessThanOrEqual(formBox.y);
    expect(formBox.y - entryBox.y - entryBox.height).toBeCloseTo(4, 0);
    expect((await entry.locator(".buzz-avatar").boundingBox()).x).toBeCloseTo(
      formBox.x,
      0,
    );
    await entry.hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "Details show channel activity",
    );
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-above-composer.png"),
    });
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    sendTyping(root.id);
    await expect(entry).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    const narrowEntry = await entry.boundingBox(),
      narrowForm = await form.boundingBox();
    expect(narrowEntry.y + narrowEntry.height).toBeLessThanOrEqual(
      narrowForm.y,
    );
    expect(narrowForm.y - narrowEntry.y - narrowEntry.height).toBeCloseTo(4, 0);
    expect((await entry.locator(".buzz-avatar").boundingBox()).x).toBeCloseTo(
      narrowForm.x,
      0,
    );
    await page.screenshot({
      path: testInfo.outputPath("thread-activity-narrow.png"),
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await entry.click();
    await expect(activityPanel(page).locator("code").first()).toHaveText(agent);
    await expect(
      activityPanel(page).getByRole("combobox", {
        name: "Channel",
        exact: true,
      }),
    ).toHaveText(/Alpha.*alpha/);
    await page
      .getByRole("button", { name: "Close channel panel", exact: true })
      .click();
    sendTyping();
    await expect(marker).toBeVisible();
    await expect(channelActivity(page)).toBeVisible();
    const channelBox = await channelActivity(page)
      .getByRole("button")
      .first()
      .boundingBox();
    const channelForm = await page
      .getByRole("form", { name: "Send a message to Alpha", exact: true })
      .boundingBox();
    expect(channelBox.y + channelBox.height).toBeLessThanOrEqual(channelForm.y);
    await expect(marker).toHaveCount(0, { timeout: 10_000 });
    await expect(channelActivity(page)).toHaveCount(0);
  });
});
