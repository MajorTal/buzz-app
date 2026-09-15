import { useAgentChoices } from "./use-agent-choices";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ComposerCompletionProps } from "../../features/conversation/contracts";
import type { RelaySession } from "../../features/relay/session";
import { Avatar } from "../../shared/Avatar";
import { matchesMentionQuery } from "./mention-query";

// Demand bookkeeping only, not another profile cache. Missing names do not issue
// the same network request on every query keystroke; explicit retry remains available.
const demands = new WeakMap<RelaySession, Set<string>>();
export function MentionCompletion({
  session,
  channelId,
  inviteAgents,
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
  const agents = useAgentChoices(session, inviteAgents);
  const channel = list.channels.find((item) => item.id === channelId);
  const parentAdmission =
    !!channel &&
    (channel.channelType !== "session" || !!channel.parentChannelId);
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
    const choices = new Map(
      agents.identities.map((agent) => [
        agent.pubkey,
        { pubkey: agent.pubkey, name: agent.name },
      ]),
    );
    for (const pubkey of members)
      choices.set(pubkey, {
        pubkey,
        name:
          profiles.get(pubkey)?.name ??
          choices.get(pubkey)?.name ??
          pubkey.slice(0, 12),
      });
    const candidates = [...choices.values()];
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
    const membershipMissing = (!inviteAgents || !!channel) && !channel?.members;
    const missing = members.some((key) => !profiles.has(key));
    const withdraw = publish({
      items: matching.slice(0, 20).map((recipient) => ({
        id: recipient.pubkey,
        label: recipient.name,
        detail: !members.includes(recipient.pubkey)
          ? `${parentAdmission ? "Adds to session and parent channel" : "Adds to session"} · ${recipient.pubkey}`
          : recipient.pubkey,
        preview: (
          <Avatar
            name={recipient.name}
            src={session.media(
              profiles.get(recipient.pubkey)?.picture ?? "",
              "small",
            )}
            className="size-7 rounded-lg text-caption"
          />
        ),
        edit: { mention: recipient },
      })),
      ...(agents.status === "error"
        ? { status: "Could not load agents. Retry to refresh." }
        : admitted && membershipMissing
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
      ...(agents.status === "error" ||
      membershipMissing ||
      list.error ||
      error ||
      missing
        ? {
            retry: () => {
              if (inviteAgents) void session.agentLibrary.refresh();
              setError(false);
              retry((value) => value + 1);
              if (membershipMissing || list.error)
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
    const agentsChanged = inviteAgents
      ? session.agentLibrary.subscribe(revoke)
      : () => {};
    return () => {
      agentsChanged();
      rosterChanged();
      profilesChanged();
      revoke();
    };
  }, [
    session,
    agents,
    inviteAgents,
    channel,
    channelId,
    memberKey,
    parentAdmission,
    profiles,
    query.query,
    publish,
    error,
    list.error,
  ]);
  return null;
}
