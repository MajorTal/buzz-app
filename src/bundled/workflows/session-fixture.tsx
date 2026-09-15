import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReadJournal } from "../../features/relay/read-state-storage";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import type { RelayEvent } from "../../features/relay/events";
import { Button } from "../../shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
import type { LiveCallbacks } from "../../features/relay/live";
import { PublishRejected } from "../../features/relay/outbox";
import { OutboxStatus } from "../channels/OutboxStatus";
import { WorkflowsPage } from "./WorkflowsPage";
import { fixtureChannel, fixtureDefinition, fixtureYaml } from "./fixtures";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../shared/styles/globals.css";

// Real session/protocol/read ownership with disposable test keys and memory only.
// No broker, network, keychain, or real workflow writes.
const writable = new URLSearchParams(location.search).has("writes");
let traffic: LiveCallbacks;
let publishCount = 0;
let finishPublish: ((value: string) => void) | undefined;
let failPublish: ((error: Error) => void) | undefined;
const viewer = keypair();
const authority = keypair();
const secondChannel = "88888888-8888-4888-8888-888888888888";
const channels = [fixtureChannel, secondChannel];
let incoming: ((events: readonly RelayEvent[]) => void) | undefined;
let generation = 0;
let currentScope = "Fixture A";
function session(scope: string) {
  let journal: ReadJournal | undefined;
  const events = channels.flatMap((channel, index) => [
    roster(authority, channel, [viewer.pubkey]),
    metadata(authority, channel, index ? "Second channel" : "First channel"),
    // The second channel exercises the real session's read-only empty state.
    ...(index
      ? []
      : [
          signed(viewer, {
            kind: 30620,
            content: fixtureYaml.replace("Message helper", `${scope} helper`),
            tags: [
              ["h", channel],
              ["d", fixtureDefinition.id],
            ],
          }),
        ]),
  ]);
  return createRelaySession(
    {
      scope,
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      media: () => undefined,
      ...(writable
        ? {
            writer: {
              kinds: [9, 30620, 46020, 5],
              sign: async (template: Parameters<typeof signed>[1]) =>
                signed(viewer, template),
              publish: () => {
                publishCount++;
                return new Promise<string>((resolve, reject) => {
                  finishPublish = resolve;
                  failPublish = reject;
                });
              },
            },
            workflows: { runs: async () => ({ runs: [], next: null }) },
          }
        : {}),
      async query(filters) {
        return events.filter((event) =>
          filters.some(
            (filter) =>
              (!filter.kinds || filter.kinds.includes(event.kind)) &&
              (!filter["#h"] ||
                event.tags.some(
                  ([k, v]) => k === "h" && v && filter["#h"]?.includes(v),
                )),
          ),
        );
      },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        traffic = callbacks;
        callbacks.state({ status: "connected", routes: [] });
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      outboxStorage: { load: () => [], save() {} },
      readStateStorage: {
        async update(change) {
          journal = change(journal);
          return journal;
        },
        close() {},
      },
    },
  );
}
let owner = session(currentScope);
Object.assign(window, {
  workflowSessionFixture: {
    publications: () => publishCount,
    state: (status: "connected" | "retrying") =>
      traffic.state({ status, routes: [] }),
    settle: () =>
      finishPublish?.(
        'response:{"run_id":"33333333-3333-4333-8333-333333333333"}',
      ),
    reject: () => failPublish?.(new PublishRejected("Fixture non-delivery")),
    operations: () => owner.session.workflows.operations.snapshot(),
    sendMessage: () =>
      owner.session.outbox?.send({
        kind: 9,
        content: "Retryable message",
        tags: [["h", fixtureChannel]],
      }),
  },
});
let snapshot: RelaySnapshot = {
  status: "ready",
  generation,
  scope: currentScope,
  viewer: viewer.pubkey,
  session: owner.session,
};
const listeners = new Set<() => void>();
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  retry() {},
  disconnect() {},
  clearCache: () => owner.clearCache(),
};
function switchScope() {
  owner.dispose();
  currentScope = currentScope === "Fixture A" ? "Fixture B" : "Fixture A";
  generation++;
  owner = session(currentScope);
  snapshot = {
    status: "ready",
    generation,
    scope: currentScope,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  for (const listener of listeners) listener();
}
function Fixture() {
  useKeyboardFocusVisibility();
  const [mounted, setMounted] = useState(true);
  return (
    <main data-buzz-ui="" className="text-body">
      <p>
        Offline production-session fixture — ephemeral keys; no network or
        writes.
      </p>
      <div className="workflow-toolbar">
        <Button onClick={switchScope}>Switch community</Button>
        <Button
          onClick={() => {
            incoming?.([roster(authority, fixtureChannel, [], 1_800_000_000)]);
          }}
        >
          Revoke selected channel
        </Button>
        <Button
          onClick={() => {
            void owner.clearCache();
          }}
        >
          Clear session cache
        </Button>
        <Button onClick={() => setMounted((value) => !value)}>
          Toggle workflows page
        </Button>
      </div>
      {mounted && <WorkflowsPage relay={relay} />}
      {writable && owner.session.outbox && (
        <OutboxStatus
          outbox={owner.session.outbox}
          profiling={owner.session.profiling}
        />
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
