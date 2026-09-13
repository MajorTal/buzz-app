// FOUNDATION: Client identity and membership selection outlive community query sessions.
import { createBrokerCommunitySetup, type CommunitySetup } from "./api";
import { waitForSetupSession } from "./setup-session";
import type { RelaySession } from "../relay/session";
import { Context } from "@deepseek-ai/cordis";
import { provideRelay, type RelayData } from "../relay/service";
import { connectBrokerTransport, type ReadTransport } from "../relay/transport";
import type { IdentityStatus } from "../identity/contracts";
import { communityDestination, isCommunityAlias } from "./destination";

/** Local intent fence, not native authority. Capture before starting an edit/join. */
export type CommunityAccount = Readonly<{
  viewer: string;
  epoch: number;
  signal: AbortSignal;
}>;
/** Host-only seam. Native IO supplies this; browser development keeps its broker. */
export interface CommunityIdentitySource {
  snapshot(): IdentityStatus | null;
  subscribe(listener: () => void): () => void;
  setup(
    identity: IdentityStatus,
    id: string,
    account: CommunityAccount,
    session: () => Promise<RelaySession>,
  ): CommunitySetup;
  connect(
    identity: IdentityStatus,
    id: string,
    signal: AbortSignal,
  ): Promise<ReadTransport>;
}

export type PersonalProfile = { name: string; picture: string };
export type Membership = { id: string; name: string; icon?: string };
type Saved = {
  profile: PersonalProfile;
  memberships: Membership[];
  selected: string | null;
};
export type ClientSnapshot = Saved & {
  status: "loading" | "ready" | "unavailable";
  epoch: number;
  viewer?: string;
  error?: string;
};
const empty = (): Saved => ({
  profile: { name: "", picture: "" },
  memberships: [],
  selected: null,
});
export function createCommunities(
  ctx: Context,
  live: boolean,
  identity?: CommunityIdentitySource,
) {
  let state: ClientSnapshot = {
    ...empty(),
    status: live && !identity ? "loading" : "unavailable",
    epoch: 0,
  };
  // Retain temporarily unresolvable deployment aliases in storage, not active UI/sessions.
  const unresolvedMemberships: Membership[] = [];
  let unresolvedSelection: string | null = null;
  let disposed = false;
  let account: CommunityAccount | undefined;
  let accountController: AbortController | undefined;
  let authority: IdentityStatus | undefined;
  let syncing = false;
  let syncAgain = false;
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  const relayListeners = new Set<() => void>();
  const sessions = new Map<string, RelayData>();
  const scopes = new Set<Context>();
  const draining = new Set<Promise<void>>();
  let cleanupFailed = false;
  const disconnectedScope = newScope();
  const disconnected = provideRelay(disconnectedScope);
  function newScope() {
    const scope = new Context();
    scopes.add(scope);
    return scope;
  }
  const current = () =>
    state.selected
      ? (sessions.get(state.selected) ?? disconnected)
      : disconnected;
  const notify = (subscribers: Set<() => void>) => {
    for (const fn of [...subscribers]) {
      try {
        fn();
      } catch {
        /* One observer cannot block retirement or siblings. */
      }
    }
  };
  const emitRelay = () => notify(relayListeners);
  const assertCurrent = (captured: CommunityAccount) => {
    if (
      disposed ||
      !captured ||
      captured !== account ||
      captured.signal.aborted ||
      state.status !== "ready"
    )
      throw new DOMException(
        "Account changed; reopen this operation",
        "AbortError",
      );
  };
  const capture = () => {
    if (!account) throw new Error("Connect your identity first");
    assertCurrent(account);
    return account;
  };
  function drain(scope: Context) {
    scopes.delete(scope);
    const work = scope.fiber.dispose().catch(() => {
      // Authority stays retired; preserve failure for final host shutdown reporting.
      cleanupFailed = true;
    });
    draining.add(work);
    void work.finally(() => draining.delete(work));
  }
  function retire() {
    const previous = [...sessions.values()];
    const previousScopes = [...scopes].filter(
      (scope) => scope !== disconnectedScope,
    );
    const controller = accountController;
    // Unpublish every old owner before cancellation/cleanup can invoke observers.
    account = undefined;
    accountController = undefined;
    authority = undefined;
    sessions.clear();
    unresolvedMemberships.length = 0;
    unresolvedSelection = null;
    state = { ...empty(), epoch: state.epoch + 1, status: "unavailable" };
    controller?.abort();
    for (const session of previous) {
      try {
        session.disconnect();
      } catch {
        /* Continue retiring sibling owners. */
      }
    }
    for (const scope of previousScopes) drain(scope);
  }
  const update = (patch: Partial<ClientSnapshot>, persist = true) => {
    const next = { ...state, ...patch };
    // A deliberate selection supersedes an unavailable saved selection; profile edits do not.
    if (persist && Object.hasOwn(patch, "selected")) unresolvedSelection = null;
    try {
      if (persist && next.viewer)
        localStorage.setItem(
          `buzz-client.v1:${next.viewer}`,
          JSON.stringify({
            profile: next.profile,
            memberships: [...next.memberships, ...unresolvedMemberships],
            selected: next.selected ?? unresolvedSelection,
          }),
        );
    } catch {
      // Preferences are best effort; storage failure must not strand a remote join.
    }
    state = next;
    notify(listeners);
    emitRelay();
  };
  const acquire = (id: string) => {
    let session = sessions.get(id);
    if (!session) {
      const captured = capture();
      const native = authority;
      session = provideRelay(newScope(), async (signal) => {
        assertCurrent(captured);
        const lifetime = AbortSignal.any([signal, captured.signal]);
        const transport =
          identity && native
            ? await identity.connect(
                native,
                communityDestination(id).url,
                lifetime,
              )
            : await connectBrokerTransport("", lifetime, id);
        assertCurrent(captured);
        if (transport.viewer !== captured.viewer)
          throw new Error("Relay identity did not match the captured account");
        if (identity && transport.scope !== communityDestination(id).url)
          throw new Error("Relay origin did not match the captured community");
        return transport;
      });
      sessions.set(id, session);
      session.subscribe(() => {
        if (state.selected === id) emitRelay();
      });
    }
    return session;
  };
  // Compatibility reader for bundled plugins; captured commands remain bound to their concrete session.
  const relay: RelayData = {
    snapshot: () => current().snapshot(),
    subscribe(fn) {
      relayListeners.add(fn);
      return () => {
        relayListeners.delete(fn);
      };
    },
    retry: () => current().retry(),
    disconnect: () => current().disconnect(),
    clearCache: () => current().clearCache(),
  };
  ctx.provide("relay", relay);
  function activate(viewer: string, native?: IdentityStatus) {
    accountController = new AbortController();
    account = Object.freeze({
      viewer,
      epoch: state.epoch,
      signal: accountController.signal,
    });
    authority = native;
    let saved = empty();
    try {
      const raw = JSON.parse(
        localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
      );
      if (raw)
        saved = {
          profile: {
            name: typeof raw.profile?.name === "string" ? raw.profile.name : "",
            picture:
              typeof raw.profile?.picture === "string"
                ? raw.profile.picture
                : "",
          },
          memberships: Array.isArray(raw.memberships)
            ? raw.memberships
                .flatMap((m: unknown): Membership[] => {
                  if (
                    !m ||
                    typeof m !== "object" ||
                    !("id" in m) ||
                    typeof m.id !== "string" ||
                    !("name" in m) ||
                    typeof m.name !== "string"
                  )
                    return [];
                  const membership = {
                    id: m.id,
                    name: m.name,
                    ...("icon" in m &&
                    typeof m.icon === "string" &&
                    m.icon.startsWith("https://")
                      ? { icon: m.icon }
                      : {}),
                  };
                  try {
                    return [
                      { ...membership, id: communityDestination(m.id).id },
                    ];
                  } catch {
                    if (
                      isCommunityAlias(m.id) &&
                      !unresolvedMemberships.some((entry) => entry.id === m.id)
                    )
                      unresolvedMemberships.push(membership);
                    return [];
                  }
                })
                .filter(
                  (m: Membership, index: number, all: Membership[]) =>
                    all.findIndex((entry) => entry.id === m.id) === index,
                )
            : [],
          selected: null,
        };
      if (typeof raw?.selected === "string") {
        try {
          saved.selected = communityDestination(raw.selected).id;
        } catch {
          if (unresolvedMemberships.some((m) => m.id === raw.selected))
            unresolvedSelection = raw.selected;
        }
      }
    } catch {
      /* Invalid local preferences do not prevent opening the client. */
    }
    if (!saved.memberships.some((m) => m.id === saved.selected))
      saved.selected = null;
    state = { ...saved, viewer, epoch: state.epoch, status: "ready" };
    if (saved.selected) acquire(saved.selected);
  }
  function syncIdentity() {
    if (disposed || !identity) return;
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    try {
      do {
        syncAgain = false;
        const next = identity.snapshot();
        const ready = next?.state === "ready" && next.pubkey ? next : undefined;
        if (
          ready &&
          authority &&
          ready.pubkey === authority.pubkey &&
          ready.generation === authority.generation &&
          ready.revocation === authority.revocation
        )
          continue;
        if (!ready && !account) continue;
        retire();
        // Cleanup may synchronously change identity. Never activate the pre-cleanup snapshot.
        const latest = identity.snapshot();
        if (!disposed && latest?.state === "ready" && latest.pubkey)
          activate(latest.pubkey, latest);
        notify(listeners);
        emitRelay();
      } while (syncAgain && !disposed);
    } finally {
      syncing = false;
    }
  }
  const unsubscribeIdentity = identity?.subscribe(syncIdentity);
  if (identity) syncIdentity();
  else if (live)
    void fetch("/api/relay/identity", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Local identity unavailable");
        const { viewer } = await response.json();
        if (typeof viewer !== "string" || !/^[a-f0-9]{64}$/.test(viewer))
          throw new Error("Invalid local identity");
        if (disposed) return;
        activate(viewer);
        notify(listeners);
        emitRelay();
      })
      .catch((error) => {
        if (!disposed)
          update({ status: "unavailable", error: String(error) }, false);
      });
  ctx.effect(() => () => {
    disposed = true;
    unsubscribeIdentity?.();
    controller.abort();
    listeners.clear();
    relayListeners.clear();
    retire();
    drain(disconnectedScope);
    return Promise.all(draining).then(() => {
      if (cleanupFailed) throw new Error("Community cleanup failed");
    });
  });
  return {
    relay,
    capture,
    assertCurrent,
    setup(id: string, captured: CommunityAccount): CommunitySetup {
      assertCurrent(captured);
      const destination = communityDestination(id);
      const native = authority;
      if (identity && !native) throw new Error("Native identity unavailable");
      const host =
        identity && native
          ? identity.setup(native, destination.url, captured, async () => {
              assertCurrent(captured);
              const owner = acquire(destination.id);
              const session = await waitForSetupSession(owner, captured.signal);
              assertCurrent(captured);
              return session;
            })
          : createBrokerCommunitySetup(destination.id, captured);
      // Account retirement fences every entry and late result, not merely React.
      async function run<T>(operation: () => Promise<T>): Promise<T> {
        assertCurrent(captured);
        const result = await operation();
        assertCurrent(captured);
        return result;
      }
      return {
        info: () => run(() => host.info()),
        inspectProfile: () => run(() => host.inspectProfile()),
        acceptPolicy: (input) => run(() => host.acceptPolicy(input)),
        claim: (input) => run(() => host.claim(input)),
        publishProfile: (profile, existing) =>
          run(() => host.publishProfile(profile, existing)),
      };
    },
    snapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    select(id: string | null) {
      if (disposed) return;
      if (id) capture();
      if (id) id = communityDestination(id).id;
      if (id && !state.memberships.some((m) => m.id === id))
        throw new Error("Join this community first");
      if (id) acquire(id);
      update({ selected: id });
    },
    saveProfile(profile: PersonalProfile, captured: CommunityAccount) {
      assertCurrent(captured);
      update({ profile });
    },
    joined(
      membership: Membership,
      profile: PersonalProfile,
      captured: CommunityAccount,
    ) {
      assertCurrent(captured);
      membership = {
        ...membership,
        id: communityDestination(membership.id).id,
      };
      update({
        memberships: [
          ...state.memberships.filter((m) => m.id !== membership.id),
          membership,
        ],
        profile: state.profile.name ? state.profile : profile,
        selected: membership.id,
      });
      // Observers of the local commit may revoke identity synchronously.
      assertCurrent(captured);
      const owner = acquire(membership.id);
      // Setup already acquired the origin/viewer outbox. Local membership commit
      // refreshes its reads, never replaces the journal or an in-flight write.
      if (owner.snapshot().status === "ready")
        owner.snapshot().session.channels.refreshList?.();
      else if (owner.snapshot().status !== "connecting") owner.retry();
      emitRelay();
    },
  };
}
export type Communities = ReturnType<typeof createCommunities>;
