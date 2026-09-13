// No broker, credentials or remote writes: real UI/session, ephemeral signed fixture events.
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { ConversationService } from "../../src/features/conversation/service";
import * as emojiPlugin from "../../src/bundled/emoji";
import emojiManifest from "../../src/bundled/emoji/manifest.json";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { MessageRow } from "../../src/features/messages/MessageRow";
import { createRelaySession } from "../../src/features/relay/session";
import { foldMessages } from "../../src/features/relay/fold";
import { mediaUrl } from "../../src/features/relay/transport";
import { keypair, message, signed } from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import type { LiveCallbacks } from "../../src/features/relay/live";
import "../../src/shared/styles/globals.css";

const ctx = new Context();
const manager = createPluginManager(ctx, {
  bundled: [
    { manifest: { ...emojiManifest, apiVersion: 1 }, module: emojiPlugin },
  ],
});
const extensions = new ConversationService(ctx);
window.addEventListener("pagehide", () => {
  void manager.dispose();
  void ctx.fiber.dispose();
});
const viewer = keypair(),
  relay = keypair(),
  member = keypair();
const report = {
  publications: [] as { community: string; event: RelayEvent }[],
  reads: [] as string[],
};
const sessions = ["a", "b"].map((community) => {
  const origin = `https://${community}.test`;
  let time = 1,
    fail = false;
  let live!: LiveCallbacks;
  let catalogRead: Promise<void> | undefined;
  let releaseCatalogRead: (() => void) | undefined;
  const makeSet = (empty = false) =>
    signed(member, {
      kind: 30030,
      created_at: time,
      content: "",
      tags: [
        ["d", "buzz:custom-emoji"],
        ...(empty
          ? []
          : [
              ["emoji", "party", `${origin}/media/${time}.png`],
              ...(community === "a"
                ? [
                    ["emoji", "aonly", `${origin}/media/aonly.png`],
                    ["emoji", "smile", `${origin}/media/smile.png`],
                    ["emoji", "nosource", `${origin}/media/no-source.png`],
                    ["emoji", "broken", `${origin}/media/broken.png`],
                    ["emoji", "grinning", `${origin}/media/grinning.png`],
                    ["emoji", "party-parrot", `${origin}/media/parrot.png`],
                    ["emoji", "party-parrot-wave", `${origin}/media/wave.png`],
                    [
                      "emoji",
                      "very-long-community-emoji-name-that-does-not-fit",
                      `${origin}/media/long.png`,
                    ],
                  ]
                : []),
            ]),
      ],
    });
  let catalog = makeSet();
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: community,
      media: (url) =>
        url.includes("no-source")
          ? undefined
          : mediaUrl(
              url,
              (url) => `/emoji-media/${community}/${encodeURIComponent(url)}`,
              origin,
            ),
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
      async query(filters) {
        if (filters[0]?.kinds?.includes(30030)) {
          report.reads.push(community);
          await catalogRead;
          if (fail) throw new Error("Fixture catalog offline");
          return [catalog];
        }
        return [];
      },
      writer: {
        kinds: [9],
        async sign(template) {
          return signed(viewer, template);
        },
        async publish(event) {
          report.publications.push({ community, event });
          live.receive([event]);
        },
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  const root = message(
    viewer,
    "c",
    "Historic :unknown:party: and https://example.test/:party:",
    1,
    [["emoji", "party", `${origin}/media/original.png`]],
  );
  const reaction = signed(member, {
    kind: 7,
    content: ":party:",
    tags: [
      ["e", root.id],
      ["emoji", "party", `${origin}/media/reaction.png`],
    ],
  });
  const broken = message(viewer, "c", "Broken :missing:", 2, [
    ["emoji", "missing", "javascript:bad"],
  ]);
  const unloaded = message(viewer, "c", "Unloadable :broken:", 3, [
    ["emoji", "broken", `${origin}/media/broken.png`],
  ]);
  const single = message(viewer, "c", ":party:", 4, [
    ["emoji", "party", `${origin}/media/1.png`],
  ]);
  return {
    ...owner,
    community,
    root,
    rows: foldMessages("c", relay.pubkey, [
      root,
      reaction,
      broken,
      unloaded,
      single,
    ]),
    replace(empty = false) {
      time++;
      catalog = makeSet(empty);
      live.receive([catalog]);
    },
    fail(value: boolean) {
      fail = value;
    },
    holdCatalog() {
      if (catalogRead) throw new Error("Catalog read already held");
      catalogRead = new Promise<void>((resolve) => {
        releaseCatalogRead = resolve;
      });
    },
    releaseCatalog() {
      releaseCatalogRead?.();
      catalogRead = undefined;
      releaseCatalogRead = undefined;
    },
  };
});
Object.assign(window, {
  emojiFixture: {
    report,
    replace: () => sessions[0]?.replace(),
    remove: () => sessions[0]?.replace(true),
    fail: (value: boolean) => sessions[0]?.fail(value),
    refresh: () => sessions[0]?.session.emoji.refresh(),
    holdCatalog: () => sessions[0]?.holdCatalog(),
    releaseCatalog: () => sessions[0]?.releaseCatalog(),
    status: (community: string) =>
      sessions
        .find((item) => item.community === community)
        ?.session.emoji.snapshot().status,
  },
});
function Fixture() {
  const [selected, select] = useState(0),
    [thread, setThread] = useState(false);
  const item = sessions[selected];
  if (!item) return null;
  return (
    <main
      style={{
        width: new URLSearchParams(location.search).has("narrow") ? 300 : 800,
        maxWidth: "100%",
        overflow: "hidden",
        margin: "20px auto",
      }}
    >
      <button type="button" onClick={() => select(selected === 0 ? 1 : 0)}>
        Switch community
      </button>
      <button type="button" onClick={() => setThread(!thread)}>
        Toggle thread
      </button>
      <h1>Community {item.community}</h1>
      {item.rows.map((row) => (
        <MessageRow
          extensions={extensions}
          key={row.id}
          row={row}
          profile={{ name: "Fixture Reader" }}
          media={item.session.media}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      ))}
      <MessageComposer
        extensions={extensions}
        session={item.session}
        scope={item.community}
        channelId="c"
        channelName="general"
        {...(thread ? { threadRootId: item.root.id } : {})}
      />
    </main>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
createRoot(container).render(<Fixture />);
