import { useEffect, useState } from "react";
import { useMentionChoices } from "./use-mention-choices";
import type { ComposerCompletionProps } from "../../features/conversation/contracts";
import type { RelaySession } from "../../features/relay/session";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { matchesMentionQuery } from "./mention-query";

// Demand bookkeeping only, not another profile cache. Missing names do not issue
// the same network request on every query keystroke; explicit retry remains available.
const demands = new WeakMap<RelaySession, Set<string>>();
export function MentionCompletion({
  session,
  scope,
  channelId,
  threadRootId,
  inviteAgents,
  query,
  publish,
}: ComposerCompletionProps) {
  // The host remounts this provider on every keystroke. One `@` token in one
  // composer is the chooser lifetime that keeps the last directory page.
  const model = useMentionChoices(
    session,
    channelId,
    inviteAgents,
    query.query,
    JSON.stringify(["inline", scope, channelId, threadRootId, query.start]),
  );
  const {
    profiles,
    agents,
    channel,
    list,
    choices,
    roster: draftRoster,
  } = model;
  const members = draftRoster?.map((p) => p.pubkey) ?? channel?.members ?? [];
  const memberKey = members.join(":");
  const parentAdmission =
    !!channel &&
    (channel.channelType !== "session" || !!channel.parentChannelId);
  const [attempt, retry] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (draftRoster) return;
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
  }, [session, memberKey, attempt, draftRoster]);
  useEffect(() => {
    const members = memberKey ? memberKey.split(":") : [];
    const admitted = matchesMentionQuery(
      query.query,
      [...model.candidates, ...choices].flatMap((c) => [...c.aliases, c.label]),
    );
    const matching = admitted ? choices : [];
    const membershipMissing =
      !draftRoster && (!inviteAgents || !!channel) && !channel?.members;
    const membershipError = !draftRoster && list.error;
    const missing = !draftRoster && members.some((key) => !profiles.has(key));
    // A multi-word query that continues no known name is prose, not a search.
    if (
      !admitted &&
      !model.pending &&
      !model.directory.loading &&
      !model.directory.error
    ) {
      const withdraw = publish({ items: [] });
      return () => {
        if (withdraw) withdraw();
      };
    }
    const withdraw = publish({
      spaceId: model.spaceId,
      items: matching.map(({ recipient, label, disabled }) => ({
        disabled,
        canSelect: (key) => model.canSelect(recipient.pubkey, key === " "),
        id: recipient.pubkey,
        label,
        detail:
          disabled ??
          (members.includes(recipient.pubkey)
            ? recipient.pubkey
            : inviteAgents
              ? `${parentAdmission ? "Adds to session and parent channel" : "Adds to session"} · ${recipient.pubkey}`
              : "Not in channel · Choose whether to add when you send"),
        preview: (
          <Avatar
            alt=""
            fallback={label}
            src={session.media(
              profiles.get(recipient.pubkey)?.picture ??
                model.directory.people.find(
                  (person) => person.pubkey === recipient.pubkey,
                )?.picture ??
                "",
              "small",
            )}
            size="default"
            shape={
              model.candidates.some(
                (c) => c.recipient.pubkey === recipient.pubkey && c.agent,
              )
                ? "squircle"
                : "circle"
            }
          />
        ),
        edit: { mention: recipient },
      })),
      ...(model.pending
        ? { status: "Loading recipients…" }
        : model.directory.error
          ? { status: model.directory.error }
          : !admitted
            ? {}
            : model.archives.status === "error"
              ? { status: "Archive information unavailable. Retry to refresh." }
              : agents.status === "error" || agents.error
                ? { status: "Could not load agents. Retry to refresh." }
                : admitted && membershipMissing
                  ? { status: "Channel membership unavailable." }
                  : admitted && membershipError
                    ? { status: "Could not refresh channel membership." }
                    : error || missing
                      ? {
                          status:
                            "Some names unavailable. Exact public keys still identify recipients.",
                        }
                      : model.directory.loading
                        ? { status: "Searching community…" }
                        : model.directory.more || model.truncated
                          ? {
                              status: "Narrow your search to see more members.",
                            }
                          : {}),
      ...(model.directory.error ||
      (admitted &&
        (model.archives.status === "error" ||
          agents.status === "error" ||
          agents.error ||
          membershipMissing ||
          membershipError ||
          error ||
          missing))
        ? {
            retry: () => {
              model.directory.retry();
              void session.agentChoices.refresh(!!inviteAgents);
              void session.archives?.refresh();
              setError(false);
              retry((value) => value + 1);
              if (membershipMissing || membershipError)
                session.channels.refreshList?.();
            },
          }
        : {}),
    });
    return () => {
      if (withdraw) withdraw();
    };
  }, [
    session,
    publish,
    query.query,
    memberKey,
    model,
    profiles,
    list,
    agents,
    error,
    choices,
    channel,
    draftRoster,
    inviteAgents,
    parentAdmission,
  ]);
  return null;
}
