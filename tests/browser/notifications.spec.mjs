import { test, expect } from "./fixture.mjs";
import { end, open, settle } from "./timeline.mjs";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  pluginFixtures: true,
  historyCounts: { alpha: 20, beta: 1 },
});

// Only the browser's OS boundary is replaced. The built host, session,
// verified WS → broker → SSE and navigation/Channels consumers are production.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.notificationEvents = [];
    window.notificationRequests = 0;
    window.Notification = class {
      static permission = "granted";
      static async requestPermission() {
        window.notificationRequests++;
        window.Notification.permission = "granted";
        return window.Notification.permission;
      }
      constructor(title, options) {
        this.title = title;
        this.options = options;
        this.closed = false;
        window.notificationEvents.push(this);
      }
      close() {
        this.closed = true;
        this.onclose?.();
      }
    };
  });
});
const systemCount = (page) =>
  page.evaluate(() => window.notificationEvents.length);
async function settings(page) {
  expect(
    await page.evaluate(() =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "settings",
        section: "notifications",
      }),
    ),
  ).toEqual({ status: "opened" });
  await expect(
    page.getByRole("heading", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await page.getByRole("switch", { name: "Sound", exact: true }).uncheck();
}
async function ready(page, app) {
  await open(page, app);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = window.fixtureRelay.snapshot().session;
        return (
          session.live
            .snapshot()
            .routes.some(
              (r) => r.channelId === "beta" && r.status === "live",
            ) && session.unread.sync().completeness === "snapshot"
        );
      }),
    )
    .toBe(true);
  await settings(page);
}
function liveMessage(
  app,
  content,
  { age = 0, replyTo, mentioned = true } = {},
) {
  const event = finalizeEvent(
    {
      kind: 9,
      content,
      created_at: Math.floor(Date.now() / 1000) - age,
      tags: [
        ["h", "beta"],
        ...(mentioned ? [["p", app.viewer]] : []),
        ...(replyTo ? [["e", replyTo, "", "reply"]] : []),
      ],
    },
    generateSecretKey(),
  );
  app.histories.get("primary/beta").push(event);
  app.relay.publish("primary", event);
  return event;
}

async function observed(page, id) {
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("beta", id)
            .status,
        id,
      ),
    )
    .toBe("eligible");
  // Bounded delivery is after two rendering frames, with a 100ms background cap.
  await page.waitForTimeout(150);
}

test("real live traffic alerts once; replay/reload stay quiet and choices persist", async ({
  page,
  app,
}) => {
  await ready(page, app);
  expect(await systemCount(page)).toBe(0);
  const row = liveMessage(app, "Fresh mention");
  await expect.poll(() => systemCount(page)).toBe(1);
  app.relay.publish("primary", row);
  await observed(page, row.id);
  expect(await systemCount(page)).toBe(1);
  await page.getByRole("switch", { name: "Mentions", exact: true }).uncheck();
  const muted = liveMessage(app, "Muted mention");
  await observed(page, muted.id);
  expect(await systemCount(page)).toBe(1);
  await page.reload();
  await settings(page);
  await expect(
    page.getByRole("switch", { name: "Mentions", exact: true }),
  ).not.toBeChecked();
  expect(await systemCount(page)).toBe(0);
  expect(await page.evaluate(() => window.notificationRequests)).toBe(0);
  await expect(
    page.getByRole("heading", { name: "Recent notifications" }),
  ).toHaveCount(0);
});

test("explicit Allow releases the first fresh alert; master off preserves categories", async ({
  page,
  app,
}) => {
  await ready(page, app);
  await page.evaluate(() => {
    window.Notification.permission = "default";
  });
  await page
    .getByRole("button", { name: "Check permission", exact: true })
    .click();
  const row = liveMessage(app, "Permission wait");
  await observed(page, row.id);
  expect(await systemCount(page)).toBe(0);
  expect(await page.evaluate(() => window.notificationRequests)).toBe(0);
  await page
    .getByRole("button", { name: "Allow notifications", exact: true })
    .click();
  await expect.poll(() => systemCount(page)).toBe(1);
  await page.getByRole("switch", { name: "Mentions", exact: true }).uncheck();
  await page
    .getByRole("switch", { name: "Desktop alerts", exact: true })
    .uncheck();
  await page
    .getByRole("switch", { name: "Desktop alerts", exact: true })
    .check();
  await expect(
    page.getByRole("switch", { name: "Mentions", exact: true }),
  ).not.toBeChecked();
  const muted = liveMessage(app, "Disabled category");
  await observed(page, muted.id);
  expect(await systemCount(page)).toBe(1);
});

test("a fully visible incoming row stays quiet without publishing read intent", async ({
  page,
  app,
}) => {
  const following = finalizeEvent(
    {
      kind: 9,
      content: "Following row",
      created_at: Math.floor(Date.now() / 1000) + 20,
      tags: [["h", "beta"]],
    },
    generateSecretKey(),
  );
  // Keep both rows wholly inside the viewport. A long virtualized history can
  // leave its last row fractionally clipped in WebKit, which is not "viewing".
  app.histories.set("primary/beta", [following]);
  await ready(page, app);
  await page.evaluate(
    (viewer) =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "conversation",
        channelId: "beta",
        scope: { viewer, communityOrigin: "https://primary.example" },
      }),
    app.viewer,
  );
  const history = page.getByRole("region", {
    name: "Channel message history",
    exact: true,
  });
  await settle(page);
  await page.bringToFront();
  await history.focus();
  // Establish the real reading lease before publishing: mounted DOM alone does
  // not prove that the document is focused and the timeline is ready to observe.
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.fixtureRelay.snapshot().session.unread.attention("beta", id)
            .viewing,
        following.id,
      ),
    )
    .toBe(true);
  const row = liveMessage(app, "Visible mention");
  await expect(history.locator(`[data-message-id="${row.id}"]`)).toBeInViewport(
    { ratio: 1 },
  );
  await observed(page, row.id);
  expect(await systemCount(page)).toBe(0);
  expect(
    await page.evaluate(
      (id) =>
        window.fixtureRelay.snapshot().session.unread.attention("beta", id)
          .unread,
      row.id,
    ),
  ).toBe(true);
  await settings(page);
  await page
    .getByRole("switch", { name: "Notify while viewing", exact: true })
    .check();
  await page.evaluate(
    (viewer) =>
      window.fixtureNavigation.open({
        version: 1,
        kind: "conversation",
        channelId: "beta",
        scope: { viewer, communityOrigin: "https://primary.example" },
      }),
    app.viewer,
  );
  await settle(page);
  await history.focus();
  liveMessage(app, "Allowed visible mention");
  await expect.poll(() => systemCount(page)).toBe(1);
});

for (const kind of ["mention", "thread reply"]) {
  test(`live ${kind} notification focuses its exact row in the normal conversation, then ordinary dwell reads it`, async ({
    page,
    app,
  }) => {
    // Only this geometry scenario needs an overflowing Beta history.
    if (kind === "mention") {
      for (let i = 0; i < 20; i++) {
        app.append("primary", "beta", `Earlier message ${i}`, false, false);
      }
    }
    // Model a real prior contribution in relay history, not a client-side
    // participation/readiness override. The incoming reply itself has no p tag.
    const root =
      kind === "thread reply"
        ? app.append("primary", "beta", "My prior thread", false)
        : undefined;
    await ready(page, app);
    if (root)
      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              window.fixtureRelay
                .snapshot()
                .session.unread.attention("beta", id).status,
            root.id,
          ),
        )
        .toBe("ineligible"); // Own root is verified evidence, never an alert.
    const incoming = liveMessage(app, `Selected **${kind}**`, {
      mentioned: !root,
      replyTo: root?.id,
    });
    await expect.poll(() => systemCount(page)).toBe(1);
    expect(
      await page.evaluate(() => window.notificationEvents[0].options.body),
    ).toBe(`Selected ${kind}`);
    expect(await page.evaluate(() => window.notificationEvents[0].title)).toBe(
      `${incoming.pubkey.slice(0, 10)} ${root ? "replied" : "mentioned you"} in #Beta`,
    );
    const before = app.report.readPublications.length;
    const start = performance.now();
    await page.evaluate(() => window.notificationEvents[0].onclick());
    expect(app.report.readPublications.length).toBe(before);
    const surface = page.getByRole("region", {
      name: root ? "Thread messages" : "Channel message history",
      exact: true,
    });
    const row = surface.locator(`[data-message-id="${incoming.id}"]`);
    await expect(row).toBeFocused();
    await expect(row).toBeVisible();
    await expect(row.locator("strong").filter({ hasText: kind })).toHaveText(
      kind,
    );
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
    app.report.measurements.push({
      mode: `live ${kind} click to exact conversation row`,
      clickToOpenedMs: performance.now() - start,
    });
    expect(app.report.readPublications.length).toBe(before);
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    if (root) {
      await expect(
        surface.locator(`[data-message-id="${root.id}"]`),
      ).toBeAttached();
      await expect(
        page.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => app.report.queries.some((q) => q.filter.depth_limit))
        .toBe(true);
    } else {
      await expect(
        page.getByRole("region", { name: "Thread messages", exact: true }),
      ).toHaveCount(0);
      expect(
        app.report.queries.filter((q) => q.filter.depth_limit),
      ).toHaveLength(0);
    }
    await expect
      .poll(() => app.report.readPublications.length)
      .toBeGreaterThan(before);
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.fixtureRelay.snapshot().session.unread.attention("beta", id)
              .unread,
          incoming.id,
        ),
      )
      .toBe(false);
    if (!root) {
      // Fractional reflow must not leave the last row clipped at maximum scroll.
      await row.evaluate((element) => {
        element.style.paddingBottom = "0.125px";
      });
      for (const width of [1440, 640]) {
        await page.setViewportSize({ width, height: 950 });
        await expect
          .poll(() =>
            surface.evaluate(
              (element) => element.scrollHeight > element.clientHeight,
            ),
          )
          .toBe(true);
        await end(page);
        await expect(row).toBeInViewport({ ratio: 1 });
      }
    }
  });
}

test("an installed producer shares policy and OS click navigation, including after producer disable", async ({
  page,
  app,
}) => {
  await ready(page, app);
  const input = {
    sourceKey: "plugin-event",
    target: { version: 1, kind: "settings", section: "appearance" },
  };
  expect(
    await page.evaluate((input) => window.fixtureNotify(input), input),
  ).toBe(true);
  await expect.poll(() => systemCount(page)).toBe(1);
  await page.evaluate(() =>
    window.fixtureNavigation.open({
      version: 1,
      kind: "settings",
      section: "plugins",
    }),
  );
  await page
    .getByRole("switch", { name: "Enable Notification fixture", exact: true })
    .click();
  expect(
    await page.evaluate((input) => window.fixtureNotify(input), {
      ...input,
      sourceKey: "stale",
    }),
  ).toBe(false);
  await page.evaluate(() => window.notificationEvents[0].onclick());
  await expect(
    page.getByRole("heading", { name: "Appearance", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.fixtureNavigation.snapshot().status),
  ).toBe("opened");
});

test("asynchronous browser display failure reaches Settings once without redelivery", async ({
  page,
  app,
}) => {
  await ready(page, app);
  liveMessage(app, "Browser display error");
  await expect.poll(() => systemCount(page)).toBe(1);
  await page.evaluate(() => window.notificationEvents[0].onerror?.());
  await expect(page.getByRole("alert")).toHaveText(
    "The browser could not display a notification.",
  );
  expect(
    await page.evaluate(() => {
      const item = window.notificationEvents[0];
      return {
        closed: item.closed,
        click: item.onclick,
        error: item.onerror,
        close: item.onclose,
      };
    }),
  ).toEqual({ closed: true, click: null, error: null, close: null });
  await page
    .getByRole("button", { name: "Check permission", exact: true })
    .click();
  await page.waitForTimeout(150);
  expect(await systemCount(page)).toBe(1);
});
