// Actual session and production MessageRow/surface hooks, synthetic signed transport only.
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRelaySession } from "../../src/features/relay/session";
import type { LiveCallbacks } from "../../src/features/relay/live";
import { keypair, signed } from "../../src/features/relay/testing";
import { usePresenceSurface } from "../../src/features/presence/react";
import { MessageRow } from "../../src/features/messages/MessageRow";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import "../../src/shared/styles/globals.css";
const relay = keypair(),
  viewer = keypair();
const people = Array.from({ length: 40 }, () => keypair());
let callbacks!: LiveCallbacks;
let status = "online";
let serial = 0;
const report = {
  reads: 0,
  updates: 0,
  publishes: 0,
  maximumAuthors: 0,
  currentAuthors: [] as string[],
};
const owner = createRelaySession({
  presence: true,
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: () => undefined,
  async query(filters) {
    if (!filters[0]?.kinds?.includes(20001)) return [];
    report.reads++;
    const authors = filters[0].authors ?? [];
    return status === "offline"
      ? []
      : authors.map((author) =>
          signed(relay, {
            kind: 20001,
            content: status,
            tags: [["p", author]],
          }),
        );
  },
  subscribe(value) {
    callbacks = value;
    queueMicrotask(() => callbacks.state({ status: "connected", routes: [] }));
    return {
      update() {},
      retry() {},
      dispose() {},
      presence: {
        update(authors) {
          report.updates++;
          report.currentAuthors = [...authors];
          report.maximumAuthors = Math.max(
            report.maximumAuthors,
            authors.length,
          );
          queueMicrotask(() =>
            callbacks.presenceState?.({
              status: authors.length ? "ready" : "idle",
              authors,
            }),
          );
        },
        async publish() {
          report.publishes++;
        },
      },
    };
  },
});
// Disjoint top/bottom cohorts make observing every mounted row a test failure.
const personIndex = (index: number) => (index < 500 ? 0 : 20) + (index % 20);
function row(index: number): ChannelMessage {
  return {
    id: index.toString(16).padStart(64, "0"),
    authorId: people[personIndex(index)]?.pubkey ?? viewer.pubkey,
    channelId: "fixture",
    createdAt: 1700000000 + index,
    content: `Message ${index}`,
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
    mentions: [],
    emoji: [],
  };
}
function Surface() {
  const scroller = useRef<HTMLElement>(null);
  usePresenceSurface(owner.session.presence, scroller);
  return (
    <section
      ref={scroller}
      aria-label="Presence timeline"
      style={{ height: 450, overflow: "auto", padding: 16 }}
    >
      {Array.from({ length: 1000 }, (_, index) => (
        <MessageRow
          key={row(index).id}
          row={row(index)}
          presence={owner.session.presence}
          profile={{ name: `Person ${personIndex(index)}` }}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      ))}
    </section>
  );
}
function App() {
  const [shown, show] = useState(true);
  return (
    <main>
      <button type="button" onClick={() => show(!shown)}>
        Toggle timeline
      </button>
      {shown && <Surface />}
    </main>
  );
}
Object.assign(window, {
  presenceFixture: {
    report,
    cohorts: [people.slice(0, 20), people.slice(20)].map((group) =>
      group.map((person) => person.pubkey),
    ),
    diagnostics: () => owner.diagnostics().presence,
    heartbeat(count = 1, value = status) {
      for (let n = 0; n < count; n++)
        callbacks.presence?.(
          people.map((person) =>
            signed(person, {
              kind: 20001,
              content: value,
              tags: [],
              created_at: ++serial,
            }),
          ),
        );
    },
    status(value: string) {
      status = value;
    },
    dispose: () => owner.dispose(),
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
