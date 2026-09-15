// FOUNDATION: Client identity and membership selection outlive community query sessions.
import { createPresenceActivity } from "../presence/activity";
import { Context } from "@deepseek-ai/cordis";
import { provideRelay, type RelayData } from "../relay/service";
import { connectBrokerTransport } from "../relay/transport";
import { communityDestination, isCommunityAlias } from "./destination";

export type PersonalProfile = { name: string; picture: string };
export type Membership = { id: string; name: string; icon?: string };
type Saved = {
  profile: PersonalProfile;
  memberships: Membership[];
  selected: string | null;
};
export type ClientSnapshot = Saved & {
  status: "loading" | "ready" | "unavailable";
  viewer?: string;
  error?: string;
};
const empty = (): Saved => ({
  profile: { name: "", picture: "" },
  memberships: [],
  selected: null,
});
export function createCommunities(ctx: Context, live: boolean) {
  let state: ClientSnapshot = {
    ...empty(),
    status: live ? "loading" : "unavailable",
  };
  // Retain temporarily unresolvable deployment aliases in storage, not active UI/sessions.
  const unresolvedMemberships: Membership[] = [];
  let unresolvedSelection: string | null = null;
  let disposed = false;
  const controller = new AbortController();
  const presenceActivity = createPresenceActivity();
  const listeners = new Set<() => void>();
  const relayListeners = new Set<() => void>();
  const sessions = new Map<string, RelayData>();
  const scopes: Context[] = [];
  const disconnected = provideRelay(newScope());
  function newScope() {
    const scope = new Context();
    scopes.push(scope);
    return scope;
  }
  const current = () =>
    state.selected
      ? (sessions.get(state.selected) ?? disconnected)
      : disconnected;
  const emitRelay = () => {
    for (const fn of relayListeners) fn();
  };
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
    for (const fn of listeners) fn();
    emitRelay();
  };
  const acquire = (id: string) => {
    let session = sessions.get(id);
    if (!session) {
      session = provideRelay(
        newScope(),
        (signal) => connectBrokerTransport("", signal, id),
        presenceActivity,
      );
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
  if (live)
    void fetch("/api/relay/identity", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Local identity unavailable");
        const { viewer } = await response.json();
        if (typeof viewer !== "string" || !/^[a-f0-9]{64}$/.test(viewer))
          throw new Error("Invalid local identity");
        if (disposed) return;
        let saved = empty();
        try {
          const raw = JSON.parse(
            localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
          );
          if (raw)
            saved = {
              profile: {
                name:
                  typeof raw.profile?.name === "string" ? raw.profile.name : "",
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
                          !unresolvedMemberships.some(
                            (entry) => entry.id === m.id,
                          )
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
        if (saved.selected) acquire(saved.selected);
        update({ ...saved, viewer, status: "ready" }, false);
      })
      .catch((error) => {
        if (!disposed)
          update({ status: "unavailable", error: String(error) }, false);
      });
  ctx.effect(() => () => {
    disposed = true;
    controller.abort();
    presenceActivity.dispose();
    listeners.clear();
    relayListeners.clear();
    return Promise.all(scopes.map((scope) => scope.fiber.dispose()));
  });
  return {
    relay,
    snapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    select(id: string | null) {
      if (id) id = communityDestination(id).id;
      if (id && !state.memberships.some((m) => m.id === id))
        throw new Error("Join this community first");
      if (id) acquire(id);
      update({ selected: id });
    },
    saveProfile(profile: PersonalProfile) {
      update({ profile });
    },
    joined(membership: Membership, profile: PersonalProfile) {
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
      if (sessions.has(membership.id)) sessions.get(membership.id)?.retry();
      else acquire(membership.id);
      emitRelay();
    },
  };
}
export type Communities = ReturnType<typeof createCommunities>;
