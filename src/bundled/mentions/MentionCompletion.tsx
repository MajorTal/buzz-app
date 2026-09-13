import { useEffect, useState, useSyncExternalStore } from "react";
import type { ComposerCompletionProps } from "../../features/conversation/contracts";
import type { RelaySession } from "../../features/relay/session";
import { Avatar } from "../../shared/Avatar";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { matchesMentionQuery } from "./mention-query";

// Demand bookkeeping only, not another profile cache. Missing names do not issue
// the same network request on every query keystroke; explicit retry remains available.
const demands = new WeakMap<RelaySession, Set<string>>();
export function MentionCompletion({
  session,
  channelId,
  query,
  publish,
}: ComposerCompletionProps) {
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const channel = list.channels.find((item) => item.id === channelId);
  const members = channel?.members ?? [];
  const memberKey = members.join(":");
  const [attempt, retry] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    session.channels.ensureList();
    const requested = demands.get(session) ?? new Set<string>();
    demands.set(session, requested);
    const ids = memberKey
      .split(":")
      .filter((id) => id && (attempt > 0 || !requested.has(id)))
      .slice(0, attempt > 0 ? 1024 : Math.max(0, 1024 - requested.size));
    if (!ids.length) return;
    for (const id of ids) requested.add(id);
    let live = true;
    void session.profiles.ensure(ids, "background").catch(() => {
      if (live) setError(true);
    });
    return () => {
      live = false;
    };
  }, [session, memberKey, attempt]);
  useEffect(() => {
    const members = memberKey ? memberKey.split(":") : [];
    const candidates = members.map((pubkey) => ({
      pubkey,
      name: profiles.get(pubkey)?.name ?? pubkey.slice(0, 12),
    }));
    const needle = query.query.toLowerCase();
    const admitted = matchesMentionQuery(
      query.query,
      candidates.map((item) => item.name),
    );
    const matching =
      admitted && !channel?.archived
        ? candidates
            .filter(({ pubkey, name }) =>
              `${name} ${pubkey}`.toLowerCase().includes(needle),
            )
            .sort(
              (a, b) =>
                Number(!a.name.toLowerCase().startsWith(needle)) -
                  Number(!b.name.toLowerCase().startsWith(needle)) ||
                a.name.localeCompare(b.name) ||
                a.pubkey.localeCompare(b.pubkey),
            )
        : [];
    const missing = members.some((key) => !profiles.has(key));
    const withdraw = publish({
      items: matching.slice(0, 20).map((recipient) => ({
        id: recipient.pubkey,
        label: recipient.name,
        detail: recipient.pubkey,
        preview: (
          <Avatar
            name={recipient.name}
            src={session.media(profiles.get(recipient.pubkey)?.picture ?? "")}
            className="size-7 rounded-lg text-xs"
            shape={agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"}
          />
        ),
        edit: { mention: recipient },
      })),
      ...(admitted && !channel?.members
        ? { status: "Channel membership unavailable." }
        : admitted && list.error
          ? { status: "Could not refresh channel membership." }
          : error || missing
            ? {
                status:
                  "Some names unavailable. Exact public keys still identify recipients.",
              }
            : matching.length > 20
              ? { status: "Narrow your search to see more members." }
              : {}),
      ...(!channel?.members || list.error || error || missing
        ? {
            retry: () => {
              setError(false);
              retry((value) => value + 1);
              if (!channel?.members || list.error)
                session.channels.refreshList?.();
            },
          }
        : {}),
    });
    // Invalidate displayed choices synchronously, before React paints new data.
    const revoke = () => {
      if (withdraw) withdraw();
    };
    const rosterChanged = session.channels.subscribeList(() => {
      const next = session.channels.list();
      // Other channels' previews and list loading notifications are not new
      // evidence for this menu. Revoke only what the effect will republish.
      if (
        next.channels.find((item) => item.id === channelId) !== channel ||
        next.error !== list.error
      )
        revoke();
    });
    const profilesChanged = session.profiles.subscribe(() => {
      if (session.profiles.snapshot() !== profiles) revoke();
    });
    return () => {
      rosterChanged();
      profilesChanged();
      revoke();
    };
  }, [
    session,
    channel,
    channelId,
    memberKey,
    profiles,
    query.query,
    publish,
    error,
    list.error,
  ]);
  return null;
}
