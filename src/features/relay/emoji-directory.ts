import type { UploadedAttachment } from "./attachments";
import { byteSize } from "./budget";
import {
  EMOJI_SET,
  EMOJI_SET_KIND,
  emojiTags,
  emojiMatches,
  messageParts,
  normalizeShortcode,
  referencedEmoji,
  type CustomEmoji,
} from "./emoji";
import { eventDto, newer, type RelayEvent } from "./events";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";

export type EmojiSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  entries: readonly CustomEmoji[];
  /** The viewer's own latest set: the only one this client may republish. */
  mine: readonly CustomEmoji[];
  error?: string | undefined;
}>;
export type EmojiAuthoring = Readonly<{
  writer: RelayWriter;
  upload(file: File, signal: AbortSignal): Promise<UploadedAttachment>;
}>;
const LIMIT = 500;
const MAX_BYTES = 2 * 1024 * 1024;
/** Community-owned latest complete member sets, including empty replacement evidence.
 * No LRU eviction: forgetting a replacement can resurrect a removed shortcode. */
export function createEmojiDirectory(
  reader: RelayReader,
  notify = (listener: () => void) => listener(),
  viewer?: string,
  authoring?: EmojiAuthoring,
) {
  const sets = new Map<string, { event: RelayEvent; bytes: number }>();
  const listeners = new Set<() => void>();
  let bytes = 0,
    closed = false,
    requested = false,
    limited = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  const lifetime = new AbortController();
  let adding: Promise<unknown> = Promise.resolve();
  let snapshot: EmojiSnapshot = Object.freeze({
    status: "idle",
    entries: Object.freeze([]),
    mine: Object.freeze([]),
  });
  function publish(patch: Partial<EmojiSnapshot> = {}) {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) notify(listener);
  }
  function accept(incoming: readonly RelayEvent[]) {
    if (closed || limited) return;
    let changed = false;
    for (const event of incoming) {
      if (
        event.kind !== 30030 ||
        event.tags.find(([name]) => name === "d")?.[1] !== EMOJI_SET
      )
        continue;
      const old = sets.get(event.pubkey);
      if (newer(old?.event, event) === old?.event) continue;
      const size = byteSize(event);
      if (
        (!old && sets.size >= LIMIT) ||
        bytes - (old?.bytes ?? 0) + size > MAX_BYTES
      ) {
        limited = true;
        publish({
          status: "error",
          entries: Object.freeze([]),
          mine: Object.freeze([]),
          error:
            "Community emoji exceeds the catalog budget. Retry after reducing the catalog.",
        });
        return;
      }
      sets.set(event.pubkey, { event, bytes: size });
      bytes += size - (old?.bytes ?? 0);
      changed = true;
    }
    if (!changed) return;
    const winners = new Map<string, { emoji: CustomEmoji; time: number }>();
    for (const { event } of sets.values())
      for (const emoji of emojiTags(event)) {
        const old = winners.get(emoji.shortcode);
        if (
          !old ||
          event.created_at > old.time ||
          (event.created_at === old.time && emoji.url < old.emoji.url)
        )
          winners.set(emoji.shortcode, { emoji, time: event.created_at });
      }
    publish({
      entries: Object.freeze(
        [...winners.values()]
          .map(({ emoji }) => emoji)
          .sort((a, b) => a.shortcode.localeCompare(b.shortcode)),
      ),
      mine: viewer
        ? emojiTags(sets.get(viewer)?.event ?? { tags: [] })
        : snapshot.mine,
    });
  }
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    requested = true;
    if (pending) return pending;
    // Explicit recovery starts a new bounded read after overflow. Never expose a
    // partially retained set as ready; live replacements during this read still win.
    if (limited) {
      sets.clear();
      bytes = 0;
      limited = false;
    }
    const owned = new AbortController();
    controller = owned;
    publish({ status: "loading", error: undefined });
    pending = (async () => {
      try {
        const events = await reader.read(
          [{ kinds: [30030], "#d": [EMOJI_SET], limit: LIMIT }],
          { signal: owned.signal, priority: "background" },
        );
        if (closed || owned.signal.aborted) return;
        accept(events);
        if (closed || owned.signal.aborted || limited) return;
        if (events.length >= LIMIT)
          throw new Error(
            "Community emoji catalog may be incomplete (500-set read limit). Retry after reducing the catalog.",
          );
        publish({ status: "ready", error: undefined });
      } catch (error) {
        if (!closed && !owned.signal.aborted)
          publish({ status: "error", error: String(error) });
      } finally {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
      }
    })();
    return pending;
  }
  function ensure() {
    if (snapshot.status === "idle") return refresh();
    return pending ?? Promise.resolve();
  }
  /** Read-modify-write of the viewer's own set, like Desktop's `setCustomEmoji`. */
  async function publishAdd(
    writer: RelayWriter,
    shortcode: string,
    url: string,
  ): Promise<string> {
    if (!viewer) throw new Error("Failed to add emoji.");
    const timeout = AbortSignal.timeout(12_000);
    const signal = AbortSignal.any([lifetime.signal, timeout]);
    try {
      const own = await reader.read(
        [
          {
            kinds: [EMOJI_SET_KIND],
            "#d": [EMOJI_SET],
            authors: [viewer],
            limit: 1,
          },
        ],
        { signal, fresh: true },
      );
      signal.throwIfAborted();
      accept(own);
      // A capped or refused catalog must not hide the latest own set from replacement.
      let current = sets.get(viewer)?.event;
      for (const event of own)
        if (
          event.pubkey === viewer &&
          event.kind === EMOJI_SET_KIND &&
          event.tags.find(([name]) => name === "d")?.[1] === EMOJI_SET
        )
          current = newer(current, event);
      const entries = emojiTags(current ?? { tags: [] }).filter(
        (entry) => entry.shortcode !== shortcode,
      );
      const template = {
        kind: EMOJI_SET_KIND,
        created_at: Math.max(
          Math.floor(Date.now() / 1000),
          (current?.created_at ?? 0) + 1,
        ),
        content: "",
        tags: [
          ["d", EMOJI_SET],
          ...[...entries, { shortcode, url }].map((entry) => [
            "emoji",
            entry.shortcode,
            entry.url,
          ]),
        ],
      };
      const event = eventDto(await writer.sign(template, signal));
      if (
        event.pubkey !== viewer ||
        event.kind !== template.kind ||
        event.created_at !== template.created_at ||
        event.content !== template.content ||
        JSON.stringify(event.tags) !== JSON.stringify(template.tags)
      )
        throw new Error("Failed to add emoji.");
      signal.throwIfAborted();
      await writer.publish(event, signal);
      signal.throwIfAborted();
      accept([event]);
      return shortcode;
    } catch {
      throw new Error(
        timeout.aborted
          ? "Timed out while adding emoji."
          : "Failed to add emoji.",
      );
    }
  }
  const queries = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure,
    refresh,
    ...(authoring
      ? {
          upload: authoring.upload,
          /** Adds or replaces one shortcode; returns the normalized shortcode. */
          add(name: string, url: string): Promise<string> {
            const shortcode = normalizeShortcode(name);
            if (!shortcode)
              return Promise.reject(
                new Error(
                  "Invalid emoji name. Use letters, numbers, hyphen, or underscore.",
                ),
              );
            if (closed)
              return Promise.reject(new Error("Failed to add emoji."));
            // Serialize local writers so concurrent adds cannot drop each other.
            const run = adding.then(() =>
              publishAdd(authoring.writer, shortcode, url),
            );
            adding = run.catch(() => undefined);
            return run;
          },
        }
      : {}),
  });
  function clear() {
    controller?.abort();
    controller = undefined;
    pending = undefined;
    sets.clear();
    bytes = 0;
    limited = false;
    publish({
      status: "idle",
      entries: Object.freeze([]),
      mine: Object.freeze([]),
      error: undefined,
    });
    // Authority can cancel the initial optional read. Restart once per clear, not per render.
    if (requested && !closed)
      queueMicrotask(() => {
        if (!closed) void ensure();
      });
  }
  return {
    queries,
    accept,
    clear,
    reconnect() {
      if (!requested || closed) return;
      controller?.abort();
      controller = undefined;
      pending = undefined;
      void refresh();
    },
    tags(content: string): string[][] {
      const codes = referencedEmoji(content);
      if (!codes.length) return [];
      if (closed) throw new Error("Community session is closed");
      if (snapshot.status !== "ready") {
        void ensure();
        throw new Error(
          snapshot.status === "error"
            ? `Community emoji unavailable. Retry message preparation or open the emoji picker. ${snapshot.error ?? ""}`
            : "Community emoji is loading. Your draft is kept; try sending again shortly.",
        );
      }
      const used = new Map<string, string>();
      for (const part of messageParts(content)) {
        if (part.startsWith("https://")) continue;
        for (const { emoji } of emojiMatches(part, snapshot.entries))
          used.set(emoji.shortcode, emoji.url);
      }
      return [...used].map(([code, url]) => ["emoji", code, url]);
    },
    dispose() {
      closed = true;
      lifetime.abort();
      clear();
      listeners.clear();
    },
  };
}
