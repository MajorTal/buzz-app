import "../../src/shared/styles/globals.css";
import { StrictMode, useState, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { finalizeEvent } from "nostr-tools";
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { ConversationService } from "../../src/features/conversation/service";
import { bundledPlugins } from "../../src/bundled";
import { createRelaySession } from "../../src/features/relay/session";
import {
  keypair,
  metadata,
  roster,
  profile,
  message,
} from "../../src/features/relay/testing";
import { matchesEvent } from "../../src/features/relay/projection";
import type { RelayEvent } from "../../src/features/relay/events";

const viewer = keypair(),
  relay = keypair(),
  first = keypair(),
  second = keypair();
let members = [viewer.pubkey, first.pubkey, second.pubkey];
let time = 1700000000;
const publications: RelayEvent[] = [];
let incoming = (_events: readonly RelayEvent[]) => {};
let releaseProfiles = () => {};
let libraryReads = 0;
let libraryIncludesFirst = false;
const delayed = new URLSearchParams(location.search).has("delayed-profiles");
const profileGate = delayed
  ? new Promise<void>((resolve) => {
      releaseProfiles = resolve;
    })
  : Promise.resolve();
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: (url) => url,
    // Synthetic, lazy capability: only the explicit fixture action loads it.
    async readAgentLibrary() {
      libraryReads++;
      return {
        definitions: [],
        identities: libraryIncludesFirst
          ? [{ pubkey: first.pubkey, name: "Honey" }]
          : [],
      };
    },
    subscribe(callbacks) {
      incoming = callbacks.receive;
      callbacks.state({ status: "connected", routes: [] });
      return { update() {}, retry() {}, dispose() {} };
    },
    async query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        await profileGate;
      const events = [
        roster(relay, "c", members, time),
        metadata(relay, "c", "General"),
        roster(relay, "other", [viewer.pubkey], time),
        metadata(relay, "other", "Other"),
        profile(viewer, { name: "Viewer" }),
        profile(first, { name: delayed ? "Mary Jane" : "Honey" }),
        profile(second, { name: "Honey", is_agent: true }),
        ...publications,
      ];
      return events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
    writer: {
      kinds: [9],
      async sign(event) {
        return finalizeEvent(
          { ...event, tags: event.tags.map((tag) => [...tag]) },
          viewer.secret,
        );
      },
      async publish(event) {
        publications.push(event);
      },
    },
  },
  { outboxStorage: { load: () => [], save: () => {} } },
);
owner.session.channels.ensureList();
const context = new Context();
const disabledCalls: {
  inputDisabled: boolean | undefined;
  text: boolean;
  mention: boolean;
}[] = [];
const plugins = createPluginManager(context, {
  bundled: [
    ...bundledPlugins.filter(({ manifest }) =>
      ["buzz.emoji", "buzz.mentions"].includes(manifest.id),
    ),
    {
      manifest: {
        id: "test.disabled-command",
        name: "Disabled command probe",
        apiVersion: 1,
      },
      module: {
        inject: ["conversation"],
        apply(ctx) {
          ctx.conversation.registerTool({
            id: "probe",
            title: "Disabled command probe",
            component: ({ disabled, insertText, insertMention }) => {
              useLayoutEffect(() => {
                if (disabled)
                  disabledCalls.push({
                    inputDisabled:
                      document
                        .querySelector('[role="textbox"]')
                        ?.getAttribute("aria-disabled") === "true",
                    text: insertText("STALE"),
                    mention: insertMention({
                      pubkey: second.pubkey,
                      name: "Honey",
                    }),
                  });
              }, [disabled, insertText, insertMention]);
              return null;
            },
          });
        },
      },
    },
  ],
});
const conversation = new ConversationService(context);
Object.assign(window, {
  mentionFixture: {
    first: first.pubkey,
    second: second.pubkey,
    publications,
    disabledCalls,
    change: (action: "enable" | "disable", id: string) =>
      plugins.change(action, id),
    outbox: () => owner.session.outbox?.snapshot(),
    refresh: () => owner.session.channels.refreshList?.(),
    removeFirst() {
      members = [viewer.pubkey, second.pubkey];
      time++;
      owner.session.channels.refreshList?.();
    },
    releaseProfiles: () => releaseProfiles(),
    libraryReads: () => libraryReads,
    setLibraryAgent(included: boolean) {
      libraryIncludesFirst = included;
      return owner.session.agentLibrary.refresh();
    },
    list: () => owner.session.channels.list(),
    otherMessage() {
      incoming([message(viewer, "other", "Unrelated preview", ++time)]);
    },
  },
});
function Fixture() {
  const [thread, setThread] = useState(false);
  const [disabled, setDisabled] = useState(false);
  return (
    <main style={{ maxWidth: 700, padding: 40, marginTop: 380 }}>
      <button type="button" onClick={() => setThread(!thread)}>
        Toggle thread
      </button>
      <button
        type="button"
        onClick={() => {
          members = [viewer.pubkey, second.pubkey];
          time++;
          owner.session.channels.refreshList?.();
        }}
      >
        Remove first Honey
      </button>
      <button type="button" onClick={() => setDisabled(!disabled)}>
        Toggle disabled
      </button>
      <conversation.ui.Composer
        disabled={disabled}
        session={owner.session}
        scope="mentions-fixture"
        channelId="c"
        channelName="General"
        {...(thread ? { threadRootId: "a".repeat(64) } : {})}
      />
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
