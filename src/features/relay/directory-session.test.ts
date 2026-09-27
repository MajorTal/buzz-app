import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, profile, roster, scriptedTransport } from "./testing";
import type { LiveCallbacks } from "./live";
import { ReadError } from "./errors";

function setup() {
  const viewer = keypair(),
    relay = keypair(),
    person = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const query = vi.fn(wire.transport.query);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    query,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  live.state({ status: "connected", routes: [] });
  live.receive([roster(relay, "general", [viewer.pubkey])]);
  let revision = 1_700_000_000;
  const revoke = () => {
    live.receive([roster(relay, "general", [viewer.pubkey], ++revision)]);
    live.receive([roster(relay, "general", [], ++revision)]);
  };
  return { owner, live, wire, query, person, revoke };
}
it.each(["pending", "resolved"] as const)(
  "retries one %s directory page invalidated by signed access loss",
  async (ordering) => {
    const h = setup();
    try {
      const pending = h.owner.session.directMessages.people(
        "Person",
        2,
        new AbortController().signal,
      );
      void pending.catch(() => {}); // A broken recovery must fail assertions, not leak a rejection.
      const first = h.wire.next();
      if (ordering === "resolved") {
        first.respond([profile(h.person, { name: "Obsolete" })]);
        queueMicrotask(h.revoke);
      } else h.revoke();
      await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(2));
      const replacement = h.wire.next();
      expect(replacement.filters).toEqual(first.filters);
      replacement.respond([profile(h.person, { name: "Person" })]);
      expect(await pending).toEqual({
        people: [{ pubkey: h.person.pubkey, name: "Person" }],
        hasMore: false,
      });
      expect(
        h.owner.session.profiles.snapshot().get(h.person.pubkey),
      ).toBeUndefined();
    } finally {
      h.owner.dispose();
    }
  },
);
it.each(["access", "caller", "dispose", "cache", "disconnect"] as const)(
  "does not retry a recovered directory page again after %s",
  async (boundary) => {
    const h = setup();
    const caller = new AbortController();
    try {
      const pending = h.owner.session.directMessages.people(
        "",
        1,
        caller.signal,
      );
      const result = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const first = h.wire.next();
      h.revoke();
      await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(2));
      const replacement = h.wire.next();
      expect(first.signal?.aborted).toBe(true);
      if (boundary === "access") h.revoke();
      else if (boundary === "caller") caller.abort();
      else if (boundary === "dispose") h.owner.dispose();
      else if (boundary === "cache") await h.owner.clearCache();
      else h.live.state({ status: "connecting", routes: [] });
      expect(await result).toMatchObject({ error: { name: "AbortError" } });
      expect(replacement.signal?.aborted).toBe(true);
      expect(h.query).toHaveBeenCalledTimes(2);
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
  },
);
it.each([
  "caller",
  "dispose",
  "cache",
  "disconnect",
  "denied",
  "network",
  "abort",
] as const)(
  "does not recover a directory failure caused by %s",
  async (boundary) => {
    const h = setup();
    const caller = new AbortController();
    try {
      const pending = h.owner.session.directMessages.people(
        "",
        1,
        caller.signal,
      );
      const rejected = expect(pending).rejects.toThrow();
      const first = h.wire.next();
      if (["caller", "dispose", "cache", "disconnect"].includes(boundary)) {
        // Explicit cancellation wins even if an access change happened first.
        h.revoke();
        if (boundary === "caller") caller.abort();
        else if (boundary === "dispose") h.owner.dispose();
        else if (boundary === "cache") await h.owner.clearCache();
        else h.live.state({ status: "connecting", routes: [] });
      } else
        first.fail(
          boundary === "denied"
            ? new ReadError("denied", "Denied", 403)
            : boundary === "network"
              ? new Error("Network failed")
              : new DOMException("Adapter aborted", "AbortError"),
        );
      await rejected;
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(h.wire.pending).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
  },
);
