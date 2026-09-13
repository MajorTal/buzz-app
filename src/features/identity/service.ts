import {
  errorCode,
  parseStatus,
  U64_MAX,
  type IdentityBackend,
  type IdentityErrorCode,
  type IdentityStatus,
  type LegacyIdentitySource,
  type UnlockRequest,
} from "./contracts";
import {
  browserSelectionStorage,
  publicKey,
  readSelection,
  SELECTION_KEY,
  type SelectionStorage,
} from "./selection";
export { publicKey } from "./selection";

export type IdentitySnapshot = Readonly<{
  /** null hides unconfirmed authority; the last native fence stays private. */
  identity: IdentityStatus | null;
  pending: "status" | "import" | "unlock" | "signOut" | null;
  error: IdentityErrorCode | null;
  selectedPubkey: string;
  canSignOut: boolean;
}>;
export const STATUS_TIMEOUT_MS = 2_000;
export const ACTIVATION_TIMEOUT_MS = 30_000;

/** UI owner, not signing authority. Dispose on renderer teardown, never on Account unmount. */
export function createIdentity(
  backend?: IdentityBackend,
  options: { storage?: SelectionStorage | null } = {},
) {
  const storage =
    options.storage === null
      ? undefined
      : (options.storage ?? browserSelectionStorage());
  let state: IdentitySnapshot = Object.freeze({
    identity: null,
    pending: null,
    error: backend ? null : "unsupportedPlatform",
    selectedPubkey: readSelection(storage),
    canSignOut: false,
  });
  let last: IdentityStatus | null = null;
  let revoking: string | null = null;
  let disposed = false;
  let notifying = false;
  let notificationQueued = false;
  const listeners = new Set<() => void>();
  let active: { stop: () => void } | null = null;
  function notify() {
    if (disposed) return;
    if (notifying) {
      if (!notificationQueued) {
        notificationQueued = true;
        queueMicrotask(() => {
          notificationQueued = false;
          notify();
        });
      }
      return;
    }
    notifying = true;
    try {
      for (const listener of [...listeners]) {
        if (disposed) break;
        if (!listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          /* Observers cannot block revocation or one another. */
        }
      }
    } finally {
      notifying = false;
    }
  }
  function patch(patch: Partial<IdentitySnapshot>) {
    if (
      Object.entries(patch).every(
        ([key, value]) => state[key as keyof IdentitySnapshot] === value,
      )
    )
      return false;
    state = Object.freeze({ ...state, ...patch });
    return true;
  }
  function remember(pubkey: string) {
    patch({ selectedPubkey: pubkey });
    try {
      storage?.setItem(SELECTION_KEY, pubkey);
    } catch {
      /* Best-effort public hint only. */
    }
  }
  function validate(next: IdentityStatus, signingOut: boolean) {
    if (
      last &&
      (BigInt(next.generation) < BigInt(last.generation) ||
        (next.generation === last.generation &&
          JSON.stringify(next) !== JSON.stringify(last) &&
          !(
            signingOut &&
            BigInt(next.generation) === U64_MAX &&
            next.state === "unavailable"
          )))
    )
      throw { code: "cancelled" };
    // An old status cannot undo local sign-out while its outcome is unknown.
    if (revoking === next.revocation) throw { code: "cancelled" };
  }
  function run(
    pending: NonNullable<IdentitySnapshot["pending"]>,
    operation: () => Promise<unknown>,
    check: (next: IdentityStatus) => void = () => {},
  ): Promise<void> {
    // One current app-owned slot, explicit retries only. Abandoned invoke promises
    // may retain Tauri callbacks: freeing them is NOT established by this timeout.
    // Release app-owned waiters, never claim to cancel invoke or OS work.
    active?.stop();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    let settled = false;
    const slot = {
      stop: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (active === slot) active = null;
        resolve();
      },
    };
    const timeout =
      pending === "import" || pending === "unlock"
        ? ACTIVATION_TIMEOUT_MS
        : STATUS_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    const timer = setTimeout(
      () => finish(false, { code: "unavailable" }),
      timeout,
    );
    active = slot;
    // Install the fence and hide previous views before invoke or arbitrary observers.
    // Read-only reconciliation need not tear down an already confirmed host view.
    // Its failure still hides that view; every mutation hides it before dispatch.
    patch({
      ...(pending === "status" ? {} : { identity: null }),
      pending,
      error: null,
    });
    function finish(ok: boolean, value: unknown) {
      if (settled || disposed || active !== slot) return;
      try {
        if (Date.now() >= deadline) throw { code: "unavailable" };
        if (!ok) throw value;
        const next = parseStatus(value);
        validate(next, pending === "signOut");
        check(next);
        last = next;
        revoking = null;
        patch({ identity: next, pending: null, error: null, canSignOut: true });
        if (next.pubkey) remember(next.pubkey);
      } catch (error) {
        patch({ identity: null, pending: null, error: errorCode(error) });
      }
      slot.stop();
      notify();
    }
    try {
      // Dispatch before notification: cleanup observers cannot get ahead of revocation.
      void Promise.resolve(operation()).then(
        (value) => finish(true, value),
        (error: unknown) => finish(false, error),
      );
    } catch (error) {
      finish(false, error);
    }
    if (active === slot) notify();
    return promise;
  }
  function refresh(): Promise<void> {
    if (disposed || !backend || active) return Promise.resolve();
    return run("status", () => backend.status());
  }
  function open(
    input: string,
    source?: LegacyIdentitySource,
    consent?: boolean,
  ): Promise<void> {
    if (disposed || !backend || active) return Promise.resolve();
    if (state.identity?.state !== "signedOut" || state.identity.busy)
      return Promise.resolve();
    try {
      const expectedPubkey = publicKey(input);
      if (
        source !== undefined &&
        (consent !== true ||
          !["buzzDesktopBlob", "buzzDesktopPerKey"].includes(source))
      )
        throw { code: "invalidInput" };
      const request: UnlockRequest = Object.freeze({
        expectedPubkey,
        generation: state.identity.generation,
        revocation: state.identity.revocation,
      });
      patch({ selectedPubkey: expectedPubkey });
      return run(
        source ? "import" : "unlock",
        () =>
          source
            ? backend.importLegacy(
                Object.freeze({ ...request, source, consent: true }),
              )
            : backend.unlockSaved(request),
        (next) => {
          if (
            next.revocation !== request.revocation ||
            BigInt(next.generation) !== BigInt(request.generation) + 2n
          )
            throw { code: "cancelled" };
          if (next.state !== "ready" || next.pubkey !== expectedPubkey)
            throw { code: "mismatch" };
        },
      );
    } catch (error) {
      if (patch({ error: errorCode(error) })) notify();
      return Promise.resolve();
    }
  }
  function signOut(): Promise<void> {
    if (disposed || !backend || !last || state.pending === "signOut")
      return Promise.resolve();
    const request = Object.freeze({ revocation: last.revocation });
    const generation = BigInt(last.generation);
    revoking = request.revocation;
    return run(
      "signOut",
      () => backend.signOut(request),
      (next) => {
        if (
          next.state === "ready" ||
          next.revocation === request.revocation ||
          (BigInt(next.generation) <= generation &&
            BigInt(next.generation) !== U64_MAX)
        )
          throw { code: "cancelled" };
      },
    );
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    active?.stop();
    last = null;
    revoking = null;
    patch({ identity: null, pending: null, canSignOut: false });
    listeners.clear();
  }
  void refresh();
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    unlockSaved: (input: string) => open(input),
    importLegacy: (
      input: string,
      source: LegacyIdentitySource,
      consent: boolean,
    ) => open(input, source, consent),
    signOut,
    dispose,
  };
}
export type Identity = ReturnType<typeof createIdentity>;
