import { sessionDescription } from "../sessions/metadata";
import type { Outbox } from "./outbox";
import type { ChannelQueries } from "./contracts";
import type { RelayReader } from "./reader";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Work-session commands use the same durable outbox and connection lifetime. */
export function createWorkSessions(
  outbox: Outbox | undefined,
  channels: ChannelQueries,
  reader: RelayReader,
  signal: AbortSignal,
  receipts?: Pick<Outbox, "snapshot" | "subscribe">,
  confirmCreation?: (id: string) => Promise<boolean>,
  agentKeys?: () => readonly string[],
) {
  const available = !!outbox?.supports(9007);
  function writer() {
    if (signal.aborted || !available || !outbox)
      throw new Error(
        "This community does not support saved sessions yet. Your draft is kept here.",
      );
    return outbox;
  }
  function identifier(id: string) {
    if (!uuid.test(id)) throw new Error("Invalid session identifier");
  }
  async function delivered(id: string) {
    const source = writer();
    const journal = receipts ?? source;
    const existing = journal.snapshot().find((item) => item.event.id === id);
    if (!existing) {
      if (await confirmCreation?.(id)) return;
      const events = await reader.read([{ ids: [id], limit: 1 }], { signal });
      if (events.some((event) => event.id === id)) return;
      throw new Error(
        "The saved operation could not be confirmed. Reconnect and retry.",
      );
    }
    if (existing.delivery === "failed" || existing.delivery === "unknown") {
      // Ordinary channel creation rejects a repeated channel UUID. An exact,
      // verified creation event can confirm an earlier lost acknowledgment.
      if (existing.event.kind === 9007) {
        if (await confirmCreation?.(id)) return;
        const channelId = existing.event.tags.find(
          ([name]) => name === "h",
        )?.[1];
        if (!channelId)
          throw new Error("The saved channel creation is invalid.");
        // A missed membership notification must not leave the readback hidden
        // by a stale roster. The verified reader applies signed discovery first.
        const events = await reader.read(
          [
            { kinds: [39000, 39002], "#d": [channelId], limit: 2 },
            { ids: [id], limit: 1 },
          ],
          { signal },
        );
        if (
          events.some(
            (event) =>
              event.id === id && event.pubkey === existing.event.pubkey,
          )
        )
          return;
      }
      source.retry(id);
    }
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const aborted = () =>
        finish(
          new Error("The community connection changed. Your draft is kept."),
        );
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Still waiting for confirmation. Retry without starting another session.",
            ),
          ),
        15000,
      );
      const inspect = () => {
        const item = journal.snapshot().find((item) => item.event.id === id);
        if (item?.delivery === "accepted" || item?.delivery === "seen")
          finish();
        else if (item?.delivery === "failed" || item?.delivery === "unknown")
          finish(
            new Error(item.error ?? "The operation could not be confirmed."),
          );
      };
      unsubscribe = journal.subscribe(inspect);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      else inspect();
    });
  }
  async function refresh(
    id: string,
    expected: {
      member?: string;
      members?: readonly string[];
      parent?: string;
    } = {},
    sessionOnly = true,
  ) {
    writer();
    const wait = new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const done = (error?: Error) => {
        unsubscribe();
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const abort = () => done(new Error("The community connection changed."));
      const timer = setTimeout(
        () =>
          done(
            new Error(
              "Session saved, but its membership is still loading. Retry to continue.",
            ),
          ),
        15000,
      );
      const inspect = () => {
        const list = channels.list();
        if (list.status === "error")
          done(new Error(list.error ?? "Session membership could not load."));
        else if (
          list.status === "ready" &&
          list.channels.some(
            (channel) =>
              channel.id === id &&
              (!sessionOnly || channel.channelType === "session") &&
              (!expected.member ||
                channel.members?.includes(expected.member)) &&
              (!expected.members ||
                expected.members.every((key) =>
                  channel.members?.includes(key),
                )) &&
              (!expected.parent || channel.parentChannelId === expected.parent),
          )
        )
          done();
      };
      unsubscribe = channels.subscribeList(inspect);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    channels.refreshList?.();
    await wait;
  }
  async function addAgents(
    id: string,
    keys: readonly string[],
    active = () => true,
  ) {
    const find = () => channels.list().channels.find((item) => item.id === id);
    const original = find();
    const parentId = original?.parentChannelId ?? id;
    const parent = channels
      .list()
      .channels.find((item) => item.id === parentId);
    if (
      !parentId ||
      !parent?.members ||
      parent.archived ||
      !["stream", "forum", "session"].includes(parent.channelType ?? "")
    )
      throw new Error("Refresh the parent channel before adding agents.");
    const unique = [...new Set(keys)];
    const known = new Set(agentKeys?.() ?? []);
    if (unique.some((key) => !parent.members?.includes(key) && !known.has(key)))
      throw new Error("Choose an agent from your agent library.");
    // Parent metadata organizes the UI; both channels keep their own rosters.
    const targets = parentId !== id ? [parentId, id] : [parentId];
    for (const targetId of targets) {
      for (const key of unique) {
        if (!active())
          throw new DOMException("Session submission cancelled", "AbortError");
        writer();
        if (find()?.parentChannelId !== original?.parentChannelId)
          throw new Error("This session moved. Refresh and retry.");
        const current = channels
          .list()
          .channels.find((item) => item.id === targetId);
        if (!current?.members || current.archived)
          throw new Error("Channel membership is unavailable.");
        if (current.members.includes(key)) continue;
        const previous = (receipts ?? outbox)
          ?.snapshot()
          .find(
            (item) =>
              item.event.kind === 9000 &&
              !["accepted", "seen"].includes(item.delivery) &&
              item.event.tags.some(
                ([name, value]) => name === "h" && value === targetId,
              ) &&
              item.event.tags.some(
                ([name, value]) => name === "p" && value === key,
              ) &&
              !item.event.tags.some(([name]) => name === "role"),
          );
        const operation =
          previous?.event.id ??
          writer().send({
            kind: 9000,
            content: "",
            tags: [
              ["h", targetId],
              ["p", key],
            ],
          });
        await delivered(operation);
        await refresh(targetId, { member: key }, false);
      }
    }
    if (original?.channelType === "session")
      await refresh(id, {
        members: unique,
        ...(original.parentChannelId ? { parent: parentId } : {}),
      });
  }
  return Object.freeze({
    available,
    addAgents,
    create(id: string, title: string, parentId?: string) {
      writer();
      identifier(id);
      if (parentId) identifier(parentId);
      if (!title.trim() || [...title].length > 120)
        throw new Error("Use a session title between 1 and 120 characters.");
      if (parentId === id)
        throw new Error("A session cannot be its own parent.");
      return writer().send({
        kind: 9007,
        content: "",
        tags: [
          ["h", id],
          ["name", title],
          ["visibility", "private"],
          ["channel_type", "stream"],
          ["about", sessionDescription(parentId)],
        ],
      });
    },
    invite(id: string, pubkey: string) {
      identifier(id);
      const target = channels
        .list()
        .channels.find((channel) => channel.id === id);
      if (target?.channelType !== "session" || target.parentChannelId)
        throw new Error(
          "Manage this session’s participants in its parent channel.",
        );
      if (!/^[0-9a-f]{64}$/.test(pubkey))
        throw new Error("Choose a valid participant.");
      return writer().send({
        kind: 9000,
        content: "",
        tags: [
          ["h", id],
          ["p", pubkey],
        ],
      });
    },
    failed(id: string) {
      return (
        (receipts ?? outbox)
          ?.snapshot()
          .some((item) => item.event.id === id && item.delivery === "failed") ??
        false
      );
    },
    async discardFailed(id: string) {
      const source = writer();
      if (
        !(receipts ?? source)
          .snapshot()
          .some((item) => item.event.id === id && item.delivery === "failed")
      )
        throw new Error(
          "This operation is still unconfirmed. Retry to confirm it first.",
        );
      await source.dismiss(id);
    },
    delivered,
    refresh,
  });
}
