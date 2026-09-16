import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import { readView, writeView } from "../../shared/view-state";
import { MessageComposer } from "../messages/MessageComposer";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import type { ConversationExtensions } from "../conversation/contracts";
import { AgentChoice } from "./AgentChoice";
import styles from "./Sessions.module.css";

type PendingStart = {
  id: string;
  text: string;
  draft?: MentionDraft;
  agent?: string;
  invitationId?: string;
  creationId?: string;
  messageId?: string;
};
function readPending(
  scope: string,
  draftKey: string,
): PendingStart | undefined {
  const value = readView<Partial<PendingStart> | null>(
    scope,
    `${draftKey}:pending`,
    null,
  );
  if (
    !value ||
    typeof value.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.id) ||
    typeof value.text !== "string" ||
    value.text.length > 16000
  )
    return;
  if (
    [value.creationId, value.messageId, value.invitationId, value.agent].some(
      (id) =>
        id !== undefined &&
        (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)),
    )
  )
    return;
  return value as PendingStart;
}
export function NewSessionComposer({
  session,
  scope,
  onStarted,
  parent,
  extensions,
}: {
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  onStarted: (id: string) => void;
  parent?: ChannelSummary | undefined;
}) {
  const available = session.workSessions.available;
  const draftKey = parent ? `sessions:channel:${parent.id}` : "sessions";
  const [pending, setPending] = useState(() => readPending(scope, draftKey));
  const [agent, setAgent] = useState(() => {
    const saved = readView<unknown>(scope, `${draftKey}:new-agent`, "");
    return (
      pending?.agent ??
      (typeof saved === "string" && /^[0-9a-f]{64}$/.test(saved) ? saved : "")
    );
  });
  const [channelId] = useState(() => pending?.id ?? crypto.randomUUID());
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    container.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
  }, []);
  const save = (next: PendingStart) => {
    setPending(next);
    writeView(scope, `${draftKey}:pending`, next);
  };
  async function start(draft: MentionDraft) {
    if (
      submitting.current ||
      !(pending?.text ?? draft.text).trim() ||
      !available
    )
      return;
    submitting.current = true;
    setBusy(true);
    setEditing(false);
    setError(undefined);
    const current = pending
      ? {
          ...pending,
          ...(!pending.messageId ? { text: draft.text, draft } : {}),
        }
      : { id: channelId, text: draft.text, draft, ...(agent ? { agent } : {}) };

    save(current);
    try {
      if (
        parent &&
        !current.messageId &&
        (current.agent || mentionDraft(current.draft).recipients.length)
      ) {
        await session.agentLibrary.refresh();
        if (!mounted.current) return;
        await session.workSessions.addAgents(
          parent.id,
          [
            ...mentionDraft(current.draft).recipients.map(
              (item) => item.pubkey,
            ),
            ...(current.agent ? [current.agent] : []),
          ],
          () => mounted.current,
        );
        if (!mounted.current) return;
      }
      if (!current.creationId) {
        current.creationId = session.workSessions.create(
          current.id,
          [...current.text.trim().replace(/\s+/g, " ")].slice(0, 80).join(""),
          parent?.id,
        );
        save({ ...current });
      }
      await session.workSessions.delivered(current.creationId);
      if (!mounted.current) return;
      await session.workSessions.refresh(
        current.id,
        parent ? { parent: parent.id } : undefined,
      );
      if (!mounted.current) return;
      if (parent && !current.messageId) {
        await session.workSessions.addAgents(
          current.id,
          [
            ...mentionDraft(current.draft).recipients.map(
              (item) => item.pubkey,
            ),
            ...(current.agent ? [current.agent] : []),
          ],
          () => mounted.current,
        );
        if (!mounted.current) return;
      }
      if (current.agent && !parent) {
        if (!current.invitationId) {
          current.invitationId = session.workSessions.invite(
            current.id,
            current.agent,
          );
          save({ ...current });
        }
        await session.workSessions.delivered(current.invitationId);
        if (!mounted.current) return;
        await session.workSessions.refresh(current.id, {
          member: current.agent,
        });
        if (!mounted.current) return;
      }
      if (!current.messageId) {
        const mentions = mentionDraft(current.draft).recipients.map(
          (item) => item.pubkey,
        );
        if (!parent && mentions.length) {
          await session.workSessions.addAgents(
            current.id,
            mentions,
            () => mounted.current,
          );
          if (!mounted.current) return;
        }
        if (!current.agent && !mentionDraft(current.draft).recipients.length) {
          const channel = session.channels
            .list()
            .channels.find((item) => item.id === current.id);
          if (!channel?.members)
            throw new Error("Refresh session participants before sending.");
          await Promise.all([
            session.profiles.ensure(channel.members, "background"),
            session.agentLibrary.snapshot().status === "ready"
              ? Promise.resolve()
              : session.agentLibrary.refresh(),
          ]);
          if (!mounted.current) return;
        }
        current.messageId = session.messages.send(
          current.id,
          current.text,
          mentions.length
            ? [...new Set(mentions)]
            : current.agent
              ? [current.agent]
              : [],
        );
        save({ ...current });
      }
      await session.workSessions.delivered(current.messageId);
      if (!mounted.current) return;
      writeView(scope, `${draftKey}:pending`, null);
      writeView(scope, `${draftKey}:new-draft`, "");
      writeView(scope, `${draftKey}:new-agent`, "");
      setAgent("");
      setPending(undefined);
      onStarted(current.id);
    } catch (reason) {
      if (!current.messageId && mounted.current) setEditing(true);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const failedId =
    pending &&
    [pending.messageId, pending.invitationId, pending.creationId].find(
      (id) => id && session.workSessions.failed(id),
    );
  async function editFailed() {
    if (!pending || !failedId || busy) return;
    setBusy(true);
    try {
      await session.workSessions.discardFailed(failedId);
      if (failedId === pending.creationId) {
        writeView(scope, `${draftKey}:pending`, null);
        setPending(undefined);
      } else {
        const next = { ...pending };
        if (failedId === next.invitationId) {
          delete next.invitationId;
          delete next.agent;
          setAgent("");
          writeView(scope, `${draftKey}:new-agent`, "");
        } else delete next.messageId;
        save(next);
      }
      setEditing(true);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div id="new-session-prompt" ref={container}>
      <MessageComposer
        trailingTool={
          <AgentChoice
            session={session}
            value={pending?.agent ?? agent}
            allowed={parent ? (parent.members ?? []) : undefined}
            parentName={parent?.name}
            disabled={
              busy ||
              (!!pending &&
                (!editing || !!pending.invitationId || !!pending.messageId))
            }
            onChange={(value) => {
              setAgent(value);
              writeView(scope, `${draftKey}:new-agent`, value);
              if (pending) {
                const next = { ...pending };
                if (value) next.agent = value;
                else delete next.agent;
                save(next);
              }
              setError(undefined);
            }}
          />
        }
        session={session}
        extensions={extensions}
        scope={scope}
        channelId={parent?.id ?? channelId}
        channelName={parent?.name ?? "this session"}
        label="Message this session"
        inviteAgents
        submission={{
          draftKey: `${draftKey}:new-draft`,
          initialDraft: pending?.draft ?? pending?.text,
          locked: busy || (!!pending && !editing),
          disabled: busy || !available,
          submit: (draft) => {
            void start(draft);
          },
        }}
      />
      {!available && (
        <p className={styles.availability} role="status">
          This connection can’t send messages. Your draft is saved.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {error && failedId && (
        <button type="button" disabled={busy} onClick={() => void editFailed()}>
          Edit and retry
        </button>
      )}
    </div>
  );
}
