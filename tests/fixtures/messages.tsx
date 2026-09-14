// A second source consumer: ordinary prop changes, no caller remount keys.
// Real React/session/outbox; local ephemeral signed events, never a live broker.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { ConversationService } from "../../src/features/conversation/service";
import { bundledPlugins } from "../../src/bundled";
import { ThreadPanel } from "../../src/features/messages/ThreadPanel";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { PublishRejected } from "../../src/features/relay/outbox";
import { threadReference } from "../../src/features/relay/threads";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import "../../src/shared/styles/globals.css";

const context = new Context();
const plugins = createPluginManager(context, {
  bundled: bundledPlugins.filter(({ manifest }) =>
    ["buzz.emoji", "buzz.mentions"].includes(manifest.id),
  ),
});
const extensions = new ConversationService(context);
const viewer = keypair(),
  agent = keypair(),
  relay = keypair();
const roots = [
  message(viewer, "one", "First root", 1),
  message(viewer, "one", "Second root", 2),
  message(viewer, "two", "Other channel root", 3),
] as const;
function channelOf(event: RelayEvent) {
  const id = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (!id) throw new Error("Missing fixture channel");
  return id;
}
const replies = roots.flatMap((root) =>
  Array.from({ length: 60 }, (_, i) =>
    message(
      viewer,
      channelOf(root),
      i === 59 && root === roots[0]
        ? `## Markdown reply
**Bold**, *italic*, and ~~done~~

first
second

1. outer
   1. nested
   2. nested two
2. ordered two

:_lead: and :trail_:

- unordered one
- unordered two

| ${"wide-column-one-".repeat(10)} | ${"wide-column-two-".repeat(10)} | ${"wide-column-three-".repeat(10)} |
| --- | --- | --- |
| one | two | three |

\`\`\`ts
const message = "${"wide-content-".repeat(35)}";
\`\`\`

[Safe link](https://example.com/path) [Unhandled link](https://example.com/unhandled)`
        : `${root.content} reply ${i}`,
      10 + i,
      [
        ["e", root.id, "", "reply"],
        ...(i === 59 && root === roots[0]
          ? ([
              ["emoji", "_lead", "https://emoji.test/lead.png"],
              ["emoji", "trail_", "https://emoji.test/trail.png"],
            ] satisfies string[][])
          : []),
      ],
    ),
  ),
);
const agentReply = signed(agent, {
  kind: 40002,
  content: JSON.stringify({
    content: `### Agent Markdown
**Rendered from an agent envelope**

\`agent-code\``,
  }),
  created_at: 70,
  tags: [
    ["h", "one"],
    ["e", roots[0].id, "", "reply"],
  ],
});
const events = [...roots, ...replies, agentReply];
const report = {
  pages: [] as string[],
  signings: [] as string[],
  publications: [] as RelayEvent[],
  links: [] as string[],
};
let incoming = (_events: readonly RelayEvent[]) => {};
const rejected = new Set<string>();
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url) =>
    url.startsWith("https://emoji.test/")
      ? `data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==`
      : undefined,
  subscribe(callbacks) {
    incoming = callbacks.receive;
    return { update() {}, retry() {}, dispose() {} };
  },
  async query(filters) {
    return filters.flatMap((filter) => {
      if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
        return [
          roster(relay, "one", [viewer.pubkey]),
          metadata(relay, "one", "One"),
          roster(relay, "two", [viewer.pubkey]),
          metadata(relay, "two", "Two"),
        ];
      if (filter.kinds?.includes(0))
        return [profile(viewer, { name: "Fixture Reader" })];
      if (filter.ids)
        return events.filter((event) => filter.ids?.includes(event.id));
      if (filter.depth_limit) {
        const rootId = filter["#e"]?.[0];
        if (!rootId) throw new Error("Missing fixture thread root");
        report.pages.push(rootId);
        return events
          .filter((event) => {
            if (threadReference(event)?.rootId !== rootId) return false;
            return (
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor ||
              (event.created_at === filter.thread_cursor &&
                event.id > (filter.thread_cursor_id ?? ""))
            );
          })
          .sort(
            (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
      }
      return [];
    });
  },
  writer: {
    kinds: [9],
    async sign(template) {
      const event = signed(viewer, template);
      report.signings.push(event.id);
      return event;
    },
    async publish(event) {
      report.publications.push(event);
      if (event.content.includes("reject") && !rejected.has(event.id)) {
        rejected.add(event.id);
        throw new PublishRejected("Fixture rejection");
      }
      if (!events.some((old) => old.id === event.id)) events.push(event);
      incoming([event]);
    },
  },
});
owner.session.channels.ensureList();
Object.assign(window, {
  messagesFixture: {
    report,
    async activate() {
      await plugins.retry();
    },
    extensionsActive() {
      return extensions.inline.snapshot().map((entry) => entry.id);
    },
    deep(kind: 9 | 40002) {
      const content = `${"> ".repeat(20_000)}literal deep message`;
      const event =
        kind === 40002
          ? signed(agent, {
              kind,
              content: JSON.stringify({ content }),
              created_at: 2_000,
              tags: [
                ["h", "one"],
                ["e", roots[0].id, "", "reply"],
              ],
            })
          : message(viewer, "one", content, 2_000, [
              ["e", roots[0].id, "", "reply"],
            ]);
      events.push(event);
      incoming([event]);
    },
    live() {
      const event = message(viewer, "one", "Live reply", 1000, [
        ["e", roots[0].id, "", "reply"],
      ]);
      events.push(event);
      incoming([event]);
    },
  },
});
function Fixture() {
  const [selected, select] = useState(0),
    [scope, setScope] = useState("fixture");
  const root = roots[selected];
  if (!root) throw new Error("Missing fixture selection");
  const channelId = channelOf(root);
  return (
    <>
      <div style={{ display: "flex", width: 600, height: 240 }}>
        <ChannelTimeline
          channelId="markdown-feed"
          scope={scope}
          queries={owner.session}
          window={{
            channelId: "markdown-feed",
            status: "ready",
            rows: [
              {
                id: "f".repeat(64),
                channelId: "markdown-feed",
                authorId: viewer.pubkey,
                createdAt: 1,
                content:
                  "## Channel Markdown\n\n**Virtualized channel row**\n\nfirst\nsecond\n\n1. channel outer\n   1. channel nested",
                mentions: [],
                participants: [],
                attachments: [],
                reactions: [],
                replyCount: 0,
              },
            ],
            hasMore: false,
            loadingOlder: false,
            error: undefined,
          }}
          onOpenLink={() => false}
        />
      </div>
      <nav>
        {roots.map((root, i) => (
          <button key={root.id} type="button" onClick={() => select(i)}>
            {root.content}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setScope(scope === "fixture" ? "other" : "fixture")}
        >
          Switch scope
        </button>
      </nav>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 440px",
          height: "80vh",
        }}
      >
        <MessageComposer
          extensions={extensions}
          session={owner.session}
          scope={scope}
          channelId={channelId}
          channelName={channelId}
        />
        <ThreadPanel
          viewer={viewer.pubkey}
          extensions={extensions}
          session={owner.session}
          scope={scope}
          channelId={channelId}
          channelName={channelId}
          messageId={root.id}
          close={() => select(0)}
          onOpenLink={(url) => {
            report.links.push(url);
            return !url.includes("unhandled");
          }}
        />
      </div>
    </>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture container");
createRoot(container).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
