import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { LocalEvents } from "../relay/outbox";
import type { AgentControl } from "../agents/control";
import { sameCommunityAgents } from "../agents/choices";

export class MembershipChanged extends Error {
  constructor() {
    super(
      "Membership changed. This agent is no longer in the channel and was not started. Select Add to invite it again.",
    );
  }
}

const keyPattern = /^[0-9a-f]{64}$/;

/** The relay remains authoritative; never offer role changes or DM expansion. */
export function canAddMembers(session: RelaySession, channel?: ChannelSummary) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel &&
    !channel.archived &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    (channel.members?.includes(session.viewer) ||
      (channel.readOnly && !channel.private))
  );
}

/** Reuse the outbox's durable operation on retry, including an unknown result. */
function waitForAddition(outbox: LocalEvents, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () =>
      finish(
        new Error(
          "Member addition interrupted. Reopen Members to check its status.",
        ),
      );
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      // Delivery alone is not membership confirmation. Always verify the roster next.
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery !== "sending")
        finish(
          new Error(
            item.error ?? "Addition is not confirmed. Retry to check again.",
          ),
        );
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}

export type MemberAdditionIntent = {
  id?: string;
  confirmed?: boolean;
  dismissed?: boolean;
};

/** Explicit single-person intent. Membership truth and pending writes stay session-owned. */
export async function addChannelMember(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  signal: AbortSignal,
  intent: MemberAdditionIntent = {},
  receipts: LocalEvents | undefined = session.outbox,
) {
  if (!keyPattern.test(pubkey))
    throw new Error("Choose a valid person or agent.");
  const channel = () =>
    session.channels.list().channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const check = () => {
    signal.throwIfAborted();
    if (!canAddMembers(session, channel()))
      throw new Error(
        "This channel cannot add members right now. Refresh and try again.",
      );
    if (session.archives.state(pubkey) === "archived")
      throw new Error(
        "Archived identities cannot be added. Choose someone else.",
      );
  };
  check();
  const outbox = session.outbox;
  if (!outbox) throw new Error("Member additions are unavailable.");
  await outbox.ready();
  check();
  // This existing session operation verifies the connected relay's signed roster.
  await session.workSessions.refreshMembership(channelId);
  check();
  const journal = receipts ?? outbox;
  // Only a roster-confirmed prior addition may be superseded by explicit Add.
  const fresh =
    intent.dismissed ||
    (intent.confirmed && !channel()?.members?.includes(pubkey));
  const pending = fresh
    ? undefined
    : journal
        .snapshot()
        .find(({ event, acknowledged }) =>
          intent.id
            ? event.id === intent.id
            : !acknowledged &&
              event.kind === 9000 &&
              event.tags.some(
                ([tag, value]) => tag === "h" && value === channelId,
              ) &&
              event.tags.some(
                ([tag, value]) => tag === "p" && value === pubkey,
              ) &&
              !event.tags.some(
                ([tag, value]) => tag === "role" && value !== "bot",
              ),
        );
  if (pending?.guarded && !channel()?.members?.includes(pubkey))
    throw new Error(
      "Retry this invitation from the agent’s profile so its eligibility can be checked.",
    );
  const recovery = { key: `member-add:${channelId}:${pubkey}`, value: "1" };
  if (pending && !pending.acknowledged)
    await outbox.recover(pending.event.id, recovery);
  check();
  if (channel()?.members?.includes(pubkey)) {
    if (!intent.id && pending) intent.id = pending.event.id;
    if (pending) await outbox.acknowledge(pending.event.id);
    check();
    intent.confirmed = true;
    return;
  }
  if (!fresh && intent.id && !pending)
    throw new Error(
      "The original addition receipt is unavailable. Refresh membership before trying again.",
    );
  if (
    pending?.delivery === "failed" &&
    Date.now() / 1000 - pending.event.created_at >= 15 * 60
  )
    throw new Error(
      "This addition expired. Remove its Not sent item in Outbox, then try again.",
    );
  const isAgent =
    session.agentChoices
      .snapshot()
      .identities.some((agent) => agent.pubkey === pubkey) ||
    session.profiles.snapshot().get(pubkey)?.isAgent;
  const id =
    pending?.event.id ??
    outbox.send(
      {
        kind: 9000,
        content: "",
        tags: [
          ["h", channelId],
          ["p", pubkey],
          ...(isAgent ? [["role", "bot"]] : []),
        ],
      },
      recovery,
    );
  if (pending?.delivery === "failed" || pending?.delivery === "unknown")
    outbox.retry(id);
  intent.id = id;
  intent.dismissed = false;
  intent.confirmed = false;
  await waitForAddition(journal, id, signal);
  check();
  await session.workSessions.refreshMembership(channelId);
  check();
  if (!channel()?.members?.includes(pubkey))
    throw new Error(
      "Addition is not confirmed in the member list yet. Retry to check again.",
    );
  await outbox.acknowledge(id);
  check();
  intent.confirmed = true;
}

/** Start only an exact identity managed here, after membership is confirmed. */
export async function startAddedAgent(
  control: AgentControl | undefined,
  session: RelaySession,
  channelId: string,
  pubkey: string,
  signal: AbortSignal,
  retryStart = false,
) {
  signal.throwIfAborted();
  const wasManaged =
    control &&
    sameCommunityAgents(
      control.snapshot().data?.agents ?? [],
      session.scope,
    ).some((agent) => agent.pubkey === pubkey);
  if (
    !wasManaged &&
    !session.agentChoices
      .snapshot()
      .identities.some((agent) => agent.pubkey === pubkey && agent.managed)
  )
    return;
  if (!control)
    throw new Error(
      "Added to the channel, but local agent controls are unavailable.",
    );
  // A failed start may be retried long after its successful membership write.
  if (retryStart) await session.workSessions.refreshMembership(channelId);
  signal.throwIfAborted();
  await control.refresh();
  signal.throwIfAborted();
  const state = control.snapshot();
  const agent =
    state.status === "ready" &&
    sameCommunityAgents(state.data?.agents ?? [], session.scope).find(
      (item) => item.pubkey === pubkey,
    );
  const channel =
    session.channels.list().channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  if (retryStart && !channel?.members?.includes(pubkey))
    throw new MembershipChanged();
  if (!agent || !channel?.members?.includes(pubkey))
    throw new Error(
      "Added, but the local agent could not be checked. Retry to start it.",
    );
  if (
    agent.status === "running" ||
    agent.status === "waiting" ||
    agent.status === "starting"
  )
    return;
  try {
    const result = await control.action(agent.id, "start");
    const started = result.agents.find((item) => item.id === agent.id);
    if (
      !started ||
      (started.status !== "running" &&
        started.status !== "waiting" &&
        started.status !== "starting")
    )
      throw new Error(
        started?.error ?? "The agent is not running. Retry to start it.",
      );
  } catch (error) {
    throw new Error(
      `Added to the channel, but the agent did not start. ${error instanceof Error ? error.message : "Retry to start it."}`,
    );
  }
}
