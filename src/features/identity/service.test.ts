import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityBackend, IdentityStatus } from "./contracts";
import {
  ACTIVATION_TIMEOUT_MS,
  createIdentity,
  STATUS_TIMEOUT_MS,
  type Identity,
} from "./service";
import { SELECTION_KEY } from "./selection";

// Synthetic public pins and process fences only; no live credentials or native IO.
const A = "a".repeat(64);
const B = "b".repeat(64);
const R = "00000000-0000-4000-8000-000000000001";
const S = "00000000-0000-4000-8000-000000000002";
function status(patch: Partial<IdentityStatus> = {}): IdentityStatus {
  return {
    state: "signedOut",
    pubkey: null,
    generation: "0",
    revocation: R,
    busy: false,
    reason: null,
    ...patch,
  };
}
function ready(patch: Partial<IdentityStatus> = {}) {
  return status({ state: "ready", pubkey: A, generation: "2", ...patch });
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function backend() {
  return {
    status: vi.fn<IdentityBackend["status"]>().mockResolvedValue(status()),
    unlockSaved: vi
      .fn<IdentityBackend["unlockSaved"]>()
      .mockResolvedValue(ready()),
    importLegacy: vi
      .fn<IdentityBackend["importLegacy"]>()
      .mockResolvedValue(ready()),
    signOut: vi
      .fn<IdentityBackend["signOut"]>()
      .mockResolvedValue(status({ generation: "3", revocation: S })),
  };
}
let owners: Identity[];
function owner(
  host: IdentityBackend,
  storage: Parameters<typeof createIdentity>[1] = { storage: null },
) {
  const identity = createIdentity(host, storage);
  owners.push(identity);
  return identity;
}
beforeEach(() => {
  vi.useFakeTimers();
  owners = [];
});
afterEach(() => {
  for (const identity of owners) identity.dispose();
  vi.useRealTimers();
});

describe("identity controller", () => {
  it("reconnects to native ready after ordinary renderer teardown without unlocking or revoking", async () => {
    const host = backend();
    host.status.mockResolvedValue(ready());
    const first = owner(host);
    await flush();
    expect(first.snapshot().identity).toEqual(ready());
    first.dispose();
    expect(first.snapshot().identity).toBeNull();
    const next = owner(host);
    await flush();
    expect(next.snapshot().identity).toEqual(ready());
    expect(host.unlockSaved).not.toHaveBeenCalled();
    expect(host.signOut).not.toHaveBeenCalled();
  });

  it("loads only a public selection hint and persists a successfully selected native key", async () => {
    const storage = { getItem: vi.fn(() => A), setItem: vi.fn() };
    const host = backend();
    const identity = owner(host, { storage });
    expect(identity.snapshot().selectedPubkey).toBe(A);
    expect(identity.snapshot().identity).toBeNull();
    await flush();
    expect(host.unlockSaved).not.toHaveBeenCalled();
    await identity.importLegacy(A.toUpperCase(), "buzzDesktopPerKey", true);
    expect(host.importLegacy).toHaveBeenCalledExactlyOnceWith({
      expectedPubkey: A,
      generation: "0",
      revocation: R,
      source: "buzzDesktopPerKey",
      consent: true,
    });
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(SELECTION_KEY, A);
    await identity.signOut();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(identity.snapshot().selectedPubkey).toBe(A);
  });

  it("storage exceptions cannot prevent native identity or sign-out", async () => {
    const identity = owner(backend(), {
      storage: {
        getItem() {
          throw new Error("denied");
        },
        setItem() {
          throw new Error("denied");
        },
      },
    });
    await flush();
    expect(identity.snapshot().selectedPubkey).toBe("");
    await identity.unlockSaved(A);
    expect(identity.snapshot().identity?.pubkey).toBe(A);
    await identity.signOut();
    expect(identity.snapshot().identity?.state).toBe("signedOut");
  });

  it("rejects recognizable secret input and copy without consent before mutation IPC", async () => {
    const host = backend();
    const identity = owner(host);
    await flush();
    await identity.unlockSaved("nsec1synthetic-not-a-key");
    expect(identity.snapshot().error).toBe("invalidInput");
    await identity.importLegacy(A, "buzzDesktopBlob", false);
    expect(host.unlockSaved).not.toHaveBeenCalled();
    expect(host.importLegacy).not.toHaveBeenCalled();
    expect(JSON.stringify(identity.snapshot())).not.toContain("nsec1");
  });

  it("captures immutable mutation intent and coalesces repeated clicks", async () => {
    const host = backend();
    const wait = deferred();
    host.unlockSaved.mockReturnValue(wait.promise);
    const identity = owner(host);
    await flush();
    const work = identity.unlockSaved(A);
    await identity.unlockSaved(B);
    await identity.refresh();
    const request = host.unlockSaved.mock.calls[0]?.[0];
    expect(request).toEqual({
      expectedPubkey: A,
      generation: "0",
      revocation: R,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(host.unlockSaved).toHaveBeenCalledTimes(1);
    expect(host.status).toHaveBeenCalledTimes(1);
    wait.resolve(ready());
    await work;
    expect(identity.snapshot().identity?.pubkey).toBe(A);
  });

  it.each(["status", "unlock"] as const)(
    "signs out through hung %s, clears old views before observers, and ignores late completion",
    async (kind) => {
      const host = backend();
      const wait = deferred();
      const identity = owner(host);
      await flush();
      if (kind === "status") host.status.mockReturnValueOnce(wait.promise);
      else host.unlockSaved.mockReturnValueOnce(wait.promise);
      const old =
        kind === "status" ? identity.refresh() : identity.unlockSaved(A);
      const views: unknown[] = [];
      identity.subscribe(() => {
        if (identity.snapshot().pending === "signOut") {
          expect(host.signOut).toHaveBeenCalledExactlyOnceWith({
            revocation: R,
          });
          views.push(identity.snapshot().identity);
          void identity.unlockSaved(B);
          void identity.signOut();
          throw new Error("observer failure");
        }
      });
      identity.subscribe(() => {
        if (identity.snapshot().pending === "signOut")
          views.push(identity.snapshot().identity);
      });
      await identity.signOut();
      await old;
      expect(views).toEqual([null, null]);
      expect(identity.snapshot().identity?.revocation).toBe(S);
      wait.resolve(ready());
      await flush();
      expect(identity.snapshot().identity?.state).toBe("signedOut");
      expect(host.unlockSaved).toHaveBeenCalledTimes(kind === "unlock" ? 1 : 0);
    },
  );

  it("reports missing initial status and permits explicit recovery without a retained request slot", async () => {
    const host = backend();
    const lost = deferred();
    host.status.mockReturnValueOnce(lost.promise);
    const identity = owner(host);
    expect(identity.snapshot().canSignOut).toBe(false);
    await identity.signOut();
    expect(host.signOut).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) await identity.refresh();
    expect(host.status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS);
    expect(identity.snapshot()).toMatchObject({
      identity: null,
      pending: null,
      error: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.status).toHaveBeenCalledTimes(1); // No background polling/retry.
    host.status.mockResolvedValueOnce(ready());
    await identity.refresh();
    expect(identity.snapshot().identity?.pubkey).toBe(A);
    lost.resolve(status());
    await flush();
    expect(identity.snapshot().identity?.pubkey).toBe(A);
  });

  it("releases a synchronously throwing or rejected status check for explicit retry", async () => {
    const host = backend();
    host.status
      .mockImplementationOnce(() => {
        throw new Error("private OS text");
      })
      .mockRejectedValueOnce({ code: "denied", detail: "private OS text" });
    const identity = owner(host);
    await flush();
    expect(identity.snapshot().error).toBe("unavailable");
    await identity.refresh();
    expect(identity.snapshot().error).toBe("denied");
    await identity.refresh();
    expect(identity.snapshot().identity?.state).toBe("signedOut");
    expect(JSON.stringify(identity.snapshot())).not.toContain(
      "private OS text",
    );
  });

  it("reconciles an activation timeout explicitly, respects native busy and never automatically replays mutation", async () => {
    const host = backend();
    const wait = deferred();
    host.unlockSaved.mockReturnValueOnce(wait.promise);
    const identity = owner(host);
    await flush();
    const work = identity.unlockSaved(A);
    await vi.advanceTimersByTimeAsync(ACTIVATION_TIMEOUT_MS);
    await work;
    expect(identity.snapshot()).toMatchObject({
      identity: null,
      pending: null,
      error: "unavailable",
      canSignOut: true,
    });
    await identity.unlockSaved(A);
    expect(host.unlockSaved).toHaveBeenCalledTimes(1);
    host.status.mockResolvedValueOnce(status({ generation: "1", busy: true }));
    await identity.refresh();
    await identity.unlockSaved(B);
    expect(host.unlockSaved).toHaveBeenCalledTimes(1);
    wait.resolve(ready());
    await flush(); // Its timed-out reply cannot change the view.
    expect(identity.snapshot().identity?.busy).toBe(true);
    host.status.mockResolvedValueOnce(ready());
    await identity.refresh();
    expect(identity.snapshot().identity?.pubkey).toBe(A);
  });

  it("cancelled intent requires reconciliation and a fresh explicit action", async () => {
    const host = backend();
    host.unlockSaved.mockRejectedValueOnce({ code: "cancelled" });
    const identity = owner(host);
    await flush();
    await identity.unlockSaved(A);
    expect(identity.snapshot().error).toBe("cancelled");
    expect(host.status).toHaveBeenCalledTimes(1);
    await identity.unlockSaved(A);
    expect(host.unlockSaved).toHaveBeenCalledTimes(1);
    host.status.mockResolvedValueOnce(
      status({ generation: "5", revocation: S }),
    );
    await identity.refresh();
    expect(host.unlockSaved).toHaveBeenCalledTimes(1);
    host.unlockSaved.mockResolvedValueOnce(
      ready({ generation: "7", revocation: S }),
    );
    await identity.unlockSaved(A);
    expect(host.unlockSaved).toHaveBeenLastCalledWith({
      expectedPubkey: A,
      generation: "5",
      revocation: S,
    });
  });

  it("unknown sign-out cannot adopt the old ready token, but can explicitly retry the same token", async () => {
    const host = backend();
    host.status.mockResolvedValue(ready());
    const wait = deferred();
    host.signOut.mockReturnValueOnce(wait.promise);
    const identity = owner(host);
    await flush();
    const work = identity.signOut();
    await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS);
    await work;
    await identity.refresh();
    expect(identity.snapshot()).toMatchObject({
      identity: null,
      error: "cancelled",
    });
    expect(host.signOut).toHaveBeenCalledTimes(1);
    await identity.signOut();
    expect(
      host.signOut.mock.calls.map(([request]) => request.revocation),
    ).toEqual([R, R]);
    expect(identity.snapshot().identity?.revocation).toBe(S);
    wait.resolve(ready());
    await flush();
    expect(identity.snapshot().identity?.state).toBe("signedOut");
  });

  it("reconciles a lost successful sign-out then uses only the new token for later user intent", async () => {
    const host = backend();
    const wait = deferred();
    host.signOut.mockReturnValueOnce(wait.promise);
    const identity = owner(host);
    await flush();
    const old = identity.signOut();
    await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS);
    await old;
    host.status.mockResolvedValueOnce(
      status({ generation: "1", revocation: S }),
    );
    await identity.refresh();
    host.unlockSaved.mockResolvedValueOnce(
      ready({ generation: "3", revocation: S }),
    );
    await identity.unlockSaved(A);
    wait.resolve(status({ generation: "1", revocation: S }));
    await flush();
    expect(identity.snapshot().identity?.state).toBe("ready");
    await identity.signOut();
    expect(host.signOut).toHaveBeenLastCalledWith({ revocation: S });
  });

  it.each([
    [ready({ pubkey: B }), "mismatch"],
    [ready({ generation: "1" }), "cancelled"],
    [ready({ generation: "4" }), "cancelled"],
    [ready({ revocation: S }), "cancelled"],
    [status({ generation: "2" }), "mismatch"],
    [{ ...ready(), secret: "not allowed" }, "unavailable"],
  ])(
    "fences misrouted/malformed activation response %#",
    async (reply, code) => {
      const host = backend();
      host.unlockSaved.mockResolvedValueOnce(reply);
      const identity = owner(host);
      await flush();
      await identity.unlockSaved(A);
      expect(identity.snapshot()).toMatchObject({
        identity: null,
        error: code,
      });
    },
  );

  it("uses BigInt generations above Number.MAX_SAFE_INTEGER and rejects regression/equal-generation conflict", async () => {
    const host = backend();
    const generation = "9007199254740993";
    host.status.mockResolvedValueOnce(status({ generation }));
    host.unlockSaved.mockResolvedValueOnce(
      ready({ generation: "9007199254740995" }),
    );
    const identity = owner(host);
    await flush();
    await identity.unlockSaved(A);
    expect(host.unlockSaved).toHaveBeenCalledExactlyOnceWith({
      expectedPubkey: A,
      generation,
      revocation: R,
    });
    expect(identity.snapshot().identity?.pubkey).toBe(A);
    host.status.mockResolvedValueOnce(
      ready({ generation: "9007199254740994" }),
    );
    await identity.refresh();
    expect(identity.snapshot().error).toBe("cancelled");
    host.status.mockResolvedValueOnce(
      ready({ generation: "9007199254740995", pubkey: B }),
    );
    await identity.refresh();
    expect(identity.snapshot().error).toBe("cancelled");
  });

  it("does not accept an overdue reply even if suspension delayed the timer", async () => {
    const host = backend();
    const wait = deferred();
    host.status.mockReturnValueOnce(wait.promise);
    const identity = owner(host);
    vi.setSystemTime(Date.now() + STATUS_TIMEOUT_MS + 1);
    wait.resolve(ready());
    await flush();
    expect(identity.snapshot()).toMatchObject({
      identity: null,
      error: "unavailable",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers reentrant revocation to earlier observers without recursive notification", async () => {
    const host = backend();
    const wait = deferred();
    host.signOut.mockReturnValueOnce(wait.promise);
    const identity = owner(host);
    await flush();
    const views: Array<string | null> = [];
    let depth = 0;
    let maxDepth = 0;
    identity.subscribe(() => {
      views.push(identity.snapshot().identity?.pubkey ?? null);
    });
    identity.subscribe(() => {
      depth++;
      maxDepth = Math.max(depth, maxDepth);
      if (identity.snapshot().identity?.state === "ready")
        void identity.signOut();
      depth--;
    });
    await identity.unlockSaved(A);
    await flush();
    expect(views).toContain(A);
    expect(views.at(-1)).toBeNull();
    expect(maxDepth).toBe(1);
    wait.resolve(status({ generation: "3", revocation: S }));
    await flush();
  });

  it("keeps an already confirmed view during successful read-only status reconciliation", async () => {
    const host = backend();
    host.status.mockResolvedValue(ready());
    const identity = owner(host);
    await flush();
    const before = identity.snapshot().identity;
    const wait = deferred();
    host.status.mockReturnValueOnce(wait.promise);
    const check = identity.refresh();
    expect(identity.snapshot().identity).toBe(before);
    await identity.signOut();
    wait.resolve(ready());
    await check;
    await flush();
    expect(identity.snapshot().identity?.state).toBe("signedOut");
  });

  it("deduplicates a reentrant invalid-input observer rather than spinning notifications", async () => {
    const identity = owner(backend());
    await flush();
    const listener = vi.fn(() => {
      void identity.unlockSaved("invalid");
    });
    identity.subscribe(listener);
    await identity.unlockSaved("invalid");
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("accepts sign-out at saturated native generation without accepting ready authority", async () => {
    const host = backend();
    const terminal = status({
      generation: "18446744073709551615",
      state: "unavailable",
      reason: "unavailable",
    });
    host.status.mockResolvedValueOnce(terminal);
    host.signOut.mockResolvedValueOnce({ ...terminal, revocation: S });
    const identity = owner(host);
    await flush();
    await identity.signOut();
    expect(identity.snapshot().identity?.revocation).toBe(S);
    expect(identity.snapshot().error).toBeNull();
  });

  it("dispose during an observer clears all cached authority and ignores a late reply", async () => {
    const host = backend();
    const wait = deferred();
    host.unlockSaved.mockReturnValueOnce(wait.promise);
    const identity = owner(host);
    await flush();
    identity.subscribe(() => {
      identity.dispose();
    });
    const later = vi.fn();
    identity.subscribe(later);
    await identity.unlockSaved(A);
    expect(identity.snapshot()).toMatchObject({
      identity: null,
      pending: null,
      canSignOut: false,
    });
    expect(later).not.toHaveBeenCalled();
    wait.resolve(ready());
    await flush();
    expect(identity.snapshot().identity).toBeNull();
    expect(host.signOut).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
