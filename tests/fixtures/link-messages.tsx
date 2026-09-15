import { Context } from "@deepseek-ai/cordis";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginRuntime } from "../../src/plugins/runtime";
import { ConversationService } from "../../src/features/conversation/service";
import type { PluginModule } from "../../src/plugins/api";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import type { RelaySession } from "../../src/features/relay/session";
import * as links from "../../src/bundled/links";
import { readView, writeView } from "../../src/shared/view-state";
import "../../src/shared/styles/globals.css";

// Real MessageRow + plugin lifecycle, with no relay, identity or writes.
const broken: PluginModule = {
  inject: ["conversation"],
  apply(ctx) {
    ctx.conversation.registerLink({
      id: "broken",
      title: "Broken",
      matches: () => true,
      component: () => {
        throw new Error("Expected test renderer failure");
      },
    });
  },
};
const root = new Context();
const runtime = new PluginRuntime(root, async (plugin) =>
  plugin.manifest.id === "fixture.mentions"
    ? mentionTools
    : plugin.revision === "broken"
      ? broken
      : links,
);
const conversation = new ConversationService(root);
const mentionTools: PluginModule = {
  inject: ["conversation"],
  apply(ctx) {
    ctx.conversation.registerTool({
      id: "fixture-mentions",
      title: "Example mentions",
      component: ({ insertMention }) => (
        <>
          <button
            type="button"
            onClick={() =>
              insertMention({ pubkey: "a".repeat(64), name: "Alex Chen" })
            }
          >
            Mention Alex Chen
          </button>
          <button
            type="button"
            onClick={() =>
              insertMention({ pubkey: "b".repeat(64), name: "Build Bot" })
            }
          >
            Mention Build Bot
          </button>
        </>
      ),
    });
  },
};
function mode(revision: string) {
  runtime.reconcile([
    {
      manifest: {
        id: "fixture.mentions",
        name: "Example mentions",
        apiVersion: 1,
      },
      enabled: true,
      source: "bundled",
      revision: "1",
      previous: null,
      error: null,
    },
    ...(revision === "off"
      ? []
      : [
          {
            manifest: { id: "buzz.links", name: "Links", apiVersion: 1 },
            enabled: true,
            source: "bundled",
            revision,
            previous: null,
            error: null,
          },
        ]),
  ]);
}
mode("on");
const row: ChannelMessage = {
  id: "link-row",
  channelId: "test",
  authorId: "test",
  createdAt: 1,
  content: `Looks like Material 3 or [this shadcdn/ui clone]\\([https://github.com/duobaseio/forui](https://github.com/duobaseio/forui)).\nReview <https://github.com/block/buzz/issues/1234>. Files: <https://drive.google.com/drive/folders/example>.\nAsk @Alex Chen and @Build Bot in #design.\nA message: <buzz://message?channel=design&id=${"1".repeat(64)}>. A thread: <buzz://message?channel=planning&id=${"1".repeat(64)}&thread=${"2".repeat(64)}>.`,
  mentions: ["a".repeat(64), "b".repeat(64)],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
const profiles = new Map([
  ["a".repeat(64), { name: "Alex Chen" }],
  ["b".repeat(64), { name: "Build Bot" }],
]);
const directory = {
  status: "ready",
  channels: [
    { id: "design", name: "design" },
    { id: "planning", name: "planning", hidden: true },
  ],
};
const library = {
  status: "ready",
  definitions: [],
  identities: [{ pubkey: "b".repeat(64), name: "Build Bot" }],
};
const emoji = { status: "ready", entries: [] };
const sent: Array<{ text: string; mentions: readonly string[] }> = [];
Object.assign(window, { linkComposerFixture: { sent } });
const previewSession = {
  outbox: { supports: () => true },
  emoji: {
    snapshot: () => emoji,
    subscribe: () => () => {},
    ensure: async () => {},
  },
  messages: {
    send: (_channelId: string, text: string, mentions: readonly string[]) => {
      sent.push({ text, mentions });
      return `preview-${sent.length}`;
    },
  },
  channels: { list: () => directory, subscribeList: () => () => {} },
  profiles: {
    snapshot: () => profiles,
    subscribe: () => () => {},
    ensure: async () => {},
  },
  agentLibrary: { snapshot: () => library, subscribe: () => () => {} },
  media: () => undefined,
  thread: (channelId: string) => {
    const snapshot = {
      status: "ready",
      root: {
        ...row,
        id: "1".repeat(64),
        channelId,
        authorId: "a".repeat(64),
        createdAt: 1789290300,
        content:
          channelId === "design"
            ? "Kk, so I mapped the two topologies I think we’re considering. Watch at 2x if you must lol\n\n\nMore details and the video follow here."
            : "The updated links are ready to try. Channel names keep the conversation readable, and a quick hover gives you the context before you open it. Longer messages stop after four lines so the preview stays compact. Open the conversation to read the rest and join the discussion.",
      },
      replies: [],
      canLoadMore: false,
    };
    return {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      refresh: async () => {},
      loadMore: async () => {},
      dispose: () => {},
    };
  },
} as unknown as RelaySession;
const composerScope = "link-composer-preview-v1";
if (readView(composerScope, "draft:design", null) === null) {
  writeView(composerScope, "draft:design", {
    text: row.content,
    recipients: [...profiles].map(([pubkey, profile]) => ({
      pubkey,
      name: profile.name,
      start: row.content.indexOf(`@${profile.name}`),
      end: row.content.indexOf(`@${profile.name}`) + profile.name.length + 1,
    })),
  });
}
function Preview() {
  const [opened, setOpened] = useState("No link opened");
  const [enabled, setEnabled] = useState("on");
  return (
    <main
      style={{
        maxWidth: 760,
        margin: "24px auto",
        padding: 24,
        background: "var(--surface)",
      }}
    >
      <h1>Message links</h1>
      <div>
        {["on", "off", "broken"].map((value) => (
          <button
            type="button"
            key={value}
            onClick={() => {
              mode(value);
              setEnabled(value);
            }}
          >
            Plugin {value}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            document.documentElement.dataset.colorMode =
              document.documentElement.dataset.colorMode === "dark"
                ? "light"
                : "dark";
          }}
        >
          Toggle theme
        </button>
      </div>
      <p>Plugin mode: {enabled}</p>
      <conversation.ui.Message
        row={row}
        session={previewSession}
        scope={`https://preview.example:${"a".repeat(64)}`}
        profile={{ name: "Preview" }}
        media={() => undefined}
        onOpenLink={(url) => {
          setOpened(url);
          return true;
        }}
        canOpenLink={() => true}
        day={false}
        retry={undefined}
      />
      <p role="status">{opened}</p>
      <h2>Try composing</h2>
      <conversation.ui.Composer
        scope={composerScope}
        session={previewSession}
        channelId="design"
        channelName="design"
        onSend={() => setOpened(`Preview only: ${sent.at(-1)?.text}`)}
      />
    </main>
  );
}
const mount = document.getElementById("root");
if (!mount) throw new Error("Missing root");
createRoot(mount).render(<Preview />);
import.meta.hot?.dispose(() => {
  void runtime.dispose();
  void root.fiber.dispose();
});
