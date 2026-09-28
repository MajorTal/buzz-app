import { mockIPC } from "@tauri-apps/api/mocks";
import { Context } from "@deepseek-ai/cordis";
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createIdentity } from "../../src/features/identity/service";
import { createCommunities } from "../../src/features/communities/service";
import { CommunityDialog } from "../../src/features/communities/CommunityDialog";
import { connectNativeTransport } from "../../src/features/relay/native";
import type { Outbox } from "../../src/features/relay/outbox";
import "../../src/shared/styles/globals.css";

declare global {
  interface Window {
    mockedNativeIpcInvoke(command: string, payload: unknown): Promise<unknown>;
  }
}
// The test owns the IPC endpoint across reloads. No Keychain or live relay access.
mockIPC((command, payload) => window.mockedNativeIpcInvoke(command, payload));
const ctx = new Context();
const identity = createIdentity();
const communities = createCommunities(
  ctx,
  false,
  undefined,
  "",
  undefined,
  identity.ready,
  connectNativeTransport,
);
function Delivery({ outbox }: { outbox: Outbox }) {
  const pending = useSyncExternalStore(outbox.subscribe, outbox.snapshot);
  return (
    <section>
      <button
        type="button"
        onClick={() =>
          outbox.send({
            kind: 9,
            content: "Reload recovery",
            tags: [["h", "fixture"]],
          })
        }
      >
        Send fixture message
      </button>
      {pending.map((item) => (
        <div key={item.event.id}>
          <output aria-label="Delivery">{item.delivery}</output>
          <button type="button" onClick={() => outbox.retry(item.event.id)}>
            Retry delivery
          </button>
        </div>
      ))}
    </section>
  );
}
function Fixture() {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const relay = useSyncExternalStore(
    communities.relay.subscribe,
    communities.relay.snapshot,
  );
  const [joining, setJoining] = useState(false);
  return (
    <main className="p-8">
      <h1>Mocked native IPC recovery fixture</h1>
      <p>
        Browser regression fixture; no native host, Keychain, or live relay.
      </p>
      <button
        type="button"
        disabled={client.status !== "ready"}
        onClick={() => setJoining(true)}
      >
        Add a community
      </button>
      <output aria-label="Selected community">
        {client.selected ?? "none"}
      </output>
      <output aria-label="Connection">{relay.status}</output>
      {relay.status === "ready" && relay.session.outbox && (
        <Delivery outbox={relay.session.outbox} />
      )}
      {joining && (
        <CommunityDialog
          communities={communities}
          mode="join"
          close={() => setJoining(false)}
        />
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
