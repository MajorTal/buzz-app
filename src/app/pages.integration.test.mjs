import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { setImmediate as settle } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("the app runtime exposes ready bundled pages and removes them on disable", async () => {
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, ws: false },
  });
  const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  });
  let services;
  try {
    const { createServices } = await vite.ssrLoadModule("/src/app/services.ts");
    services = createServices();
    assert.deepEqual(services.pages.snapshot(), []);
    await settle();
    assert.equal(services.pages.snapshot().length, 3);
    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 2),
    );
    assert.equal(services.conversation.inline.snapshot().length, 1);
    await services.plugins.change("disable", "buzz.emoji");
    assert.deepEqual(
      services.conversation.tools.snapshot().map((tool) => tool.pluginId),
      ["buzz.mentions"],
    );
    assert.equal(services.conversation.inline.snapshot().length, 0);
    await services.plugins.change("disable", "buzz.mentions");
    assert.equal(services.conversation.tools.snapshot().length, 0);
    await services.plugins.change("enable", "buzz.mentions");
    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 1),
    );
    await services.plugins.change("enable", "buzz.emoji");
    await vi.waitFor(() =>
      assert.equal(services.conversation.tools.snapshot().length, 2),
    );

    const { npubEncode } = await import("nostr-tools/nip19");
    const profileTarget = `nostr:${npubEncode("ab".repeat(32))}`;
    assert.equal(
      services.panels.resolve(profileTarget)?.pluginId,
      "buzz.profiles",
    );
    await services.plugins.change("disable", "buzz.profiles");
    assert.equal(services.panels.resolve(profileTarget), undefined);
    await services.plugins.change("enable", "buzz.profiles");
    await vi.waitFor(() =>
      assert.equal(
        services.panels.resolve(profileTarget)?.pluginId,
        "buzz.profiles",
      ),
    );

    const activity = services.panels
      .snapshot()
      .find((panel) => panel.pluginId === "buzz.agent-activity");
    assert.equal(activity.title, "Agent Activity");
    assert.equal(activity.launcher.icon, "/agent-activity.svg");
    assert.match(
      renderToStaticMarkup(createElement(activity.component)),
      /Connect to a community/,
    );
    await services.plugins.change("disable", "buzz.agent-activity");
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.agent-activity"),
      false,
    );
    await services.plugins.change("enable", "buzz.agent-activity");
    await vi.waitFor(() =>
      assert.ok(
        services.panels
          .snapshot()
          .some((panel) => panel.pluginId === "buzz.agent-activity"),
      ),
    );

    const firstBestie = services.panels
      .snapshot()
      .find((panel) => panel.pluginId === "buzz.bestie");
    assert.equal(firstBestie.title, "Bestie");
    assert.equal(firstBestie.launcher.icon, "/bestie.png");
    assert.match(
      renderToStaticMarkup(
        createElement(firstBestie.component, { target: "", close() {} }),
      ),
      /isn’t connected yet/,
    );
    await services.plugins.change("disable", "buzz.bestie");
    assert.equal(
      services.panels
        .snapshot()
        .some((panel) => panel.pluginId === "buzz.bestie"),
      false,
    );
    assert.equal(services.pages.snapshot().length, 3);
    await services.plugins.change("enable", "buzz.bestie");
    // Management completion is not activation completion; Cordis still owns import/disposal barriers.
    await vi.waitFor(() =>
      assert.ok(
        services.panels
          .snapshot()
          .some((panel) => panel.pluginId === "buzz.bestie"),
      ),
    );
    const secondBestie = services.panels
      .snapshot()
      .find((panel) => panel.pluginId === "buzz.bestie");
    assert.notEqual(secondBestie, firstBestie);
    assert.equal(secondBestie.revision, firstBestie.revision);
    const page = services.pages.snapshot()[0];
    assert.match(
      renderToStaticMarkup(createElement(page.component)),
      /Your channels, one conversation/,
    );
    const agents = services.pages
      .snapshot()
      .find((page) => page.pluginId === "buzz.agents");
    assert.equal(agents.title, "Agents");
    assert.match(
      renderToStaticMarkup(createElement(agents.component)),
      /Connect to a community/,
    );
    const session = services.relay.snapshot().session;
    await services.plugins.change("disable", "buzz.agents");
    assert.equal(
      services.pages.snapshot().some((page) => page.pluginId === "buzz.agents"),
      false,
    );
    assert.equal(services.relay.snapshot().session, session);
    assert.ok(session.agentLibrary);
    await services.plugins.change("disable", "buzz.channels");
    const [projects] = services.pages.snapshot();
    assert.equal(services.pages.snapshot().length, 1);
    assert.equal(projects.pluginId, "buzz.projects");
    assert.equal(projects.id, "projects");
    assert.equal(projects.title, "Projects");
    assert.equal(projects.layout, "workspace");
    assert.match(
      renderToStaticMarkup(createElement(projects.component)),
      /^<div class="[^"]*"><section aria-label="Projects" data-buzz-ui="" class="panel"><div[^>]*><h1[^>]*>Projects<\/h1><\/div><\/section><\/div>$/,
    );
    await services.plugins.change("disable", "buzz.projects");
    assert.deepEqual(services.pages.snapshot(), []);
    await services.plugins.change("enable", "buzz.projects");
    await vi.waitFor(() => {
      const [restored] = services.pages.snapshot();
      assert.equal(restored?.pluginId, "buzz.projects");
      assert.notEqual(restored, projects);
    });
  } finally {
    await services?.dispose();
    await vite.close();
    if (originalStorage)
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  }
});
