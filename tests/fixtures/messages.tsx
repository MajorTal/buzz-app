// A second source consumer: ordinary prop changes, no caller remount keys.
// Real React/session/outbox; local ephemeral signed events, never a live broker.
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { ConversationService } from "../../src/features/conversation/service";
import { bundledPlugins } from "../../src/bundled";
import { ThreadPanel } from "../../src/features/messages/ThreadPanel";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { MediaReviewViewer } from "../../src/features/messages/MediaReviewViewer";
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
import type { Attachment } from "../../src/features/relay/contracts";
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
const media = [
  { url: "https://fixture.test/media/one.png", video: false },
  { url: "https://fixture.test/media/two.png", video: false },
] as const satisfies readonly Attachment[];
const replyAttachment = {
  url: "https://fixture.test/media/reply.png",
  video: false,
} as const satisfies Attachment;
const roots = [
  signed(viewer, {
    kind: 9,
    content: "First root",
    created_at: 1,
    tags: [
      ["h", "one"],
      ...media.map((item) => ["imeta", `url ${item.url}`, "m image/png"]),
    ],
  }),
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
    i === 0 && root === roots[0]
      ? signed(viewer, {
          kind: 9,
          content: "Reply with image",
          created_at: 10,
          tags: [
            ["h", "one"],
            ["e", root.id, "", "reply"],
            ["imeta", `url ${replyAttachment.url}`, "m image/png"],
          ],
        })
      : message(
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
const exactReply = replies[0];
if (!exactReply) throw new Error("Missing exact reply fixture");
const exactReaction = signed(viewer, {
  kind: 7,
  content: "👍",
  created_at: 71,
  tags: [
    ["h", "one"],
    ["e", exactReply.id],
  ],
});
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
const events = [...roots, ...replies, exactReaction, agentReply];
const report = {
  pages: [] as string[],
  signings: [] as string[],
  publications: [] as RelayEvent[],
  links: [] as string[],
  rootId: roots[0].id,
  exactReplyId: exactReply.id,
};
let incoming = (_events: readonly RelayEvent[]) => {};
const rejected = new Set<string>();
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url) => {
    if (url.startsWith("https://emoji.test/"))
      return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    return media.some((item) => item.url === url) || url.endsWith("reply.png")
      ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Crect width='640' height='360' fill='%23666'/%3E%3C/svg%3E"
      : undefined;
  },
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
        return [
          profile(viewer, { name: "Fixture Reader" }),
          profile(agent, { name: "Agent Fixture" }),
        ].filter((event) => filter.authors?.includes(event.pubkey));
      if (filter.ids)
        return events.filter((event) => filter.ids?.includes(event.id));
      if (filter["#e"] && filter.kinds?.includes(7))
        return events.filter(
          (event) =>
            filter.kinds?.includes(event.kind) &&
            event.tags.some(
              ([name, value]) => name === "e" && filter["#e"]?.includes(value),
            ),
        );
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
    kinds: [7, 9],
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
    [scope, setScope] = useState("fixture"),
    [review, setReview] = useState<Attachment>();
  const reviewTrigger = useRef<HTMLButtonElement>(null);
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
        <button
          ref={reviewTrigger}
          type="button"
          onClick={() => setReview(media[0])}
        >
          Review image
        </button>
        <button type="button" onClick={() => setReview(replyAttachment)}>
          Review exact reply image
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
        {!review && (
          <ThreadPanel
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
        )}
      </div>
      {review && (
        <MediaReviewViewer
          attachment={review}
          extensions={extensions}
          session={owner.session}
          scope={scope}
          channelId="one"
          channelName="one"
          messageId={
            review.url === replyAttachment.url ? exactReply.id : roots[0].id
          }
          initialTime={0}
          restoreFocus={reviewTrigger}
          close={() => setReview(undefined)}
        />
      )}
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
