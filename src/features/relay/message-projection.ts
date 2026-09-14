import type { ChannelMessage } from "./contracts";
import type { EventData } from "./events";
import { foldMessages } from "./fold";
import type { OutgoingEvent } from "./outbox";
import type { RelayProfiler } from "./profiling";

import { channelRowKind as messageKind } from "./membership";
const order = (a: ChannelMessage, b: ChannelMessage) =>
  a.createdAt - b.createdAt || b.id.localeCompare(a.id);

/** Per-window indexes. New evidence folds only affected messages; status updates never fold. */
export class MessageProjection {
  private inputs = new Map<string, EventData>();
  private overlays = new Map<string, Set<string>>();
  private messages = new Map<string, ChannelMessage>();
  private deliveries = new Map<string, OutgoingEvent>();
  private rows: readonly ChannelMessage[] = Object.freeze([]);
  constructor(
    private channelId: string,
    private relayAuthor: string,
    private profiling: RelayProfiler,
  ) {}
  snapshot() {
    return this.rows;
  }
  reconcile(
    events: readonly EventData[],
    operations: readonly OutgoingEvent[],
  ) {
    const next = new Map(events.map((event) => [event.id, event]));
    const deliveries = new Map(operations.map((item) => [item.event.id, item]));
    const affected = new Set<string>();
    const targets = (event: EventData) =>
      messageKind(event.kind)
        ? [event.id]
        : event.tags.flatMap(([name, value]) =>
            name === "e" && value ? [value] : [],
          );
    for (const [id, event] of this.inputs) {
      if (next.has(id)) continue;
      for (const target of targets(event)) {
        affected.add(target);
        const refs = this.overlays.get(target);
        refs?.delete(id);
        if (!refs?.size) this.overlays.delete(target);
      }
    }
    for (const [id, event] of next) {
      // Stable event IDs identify immutable payloads, including unsigned local intent.
      if (this.inputs.has(id)) continue;
      for (const target of targets(event)) {
        affected.add(target);
        if (!messageKind(event.kind)) {
          const refs = this.overlays.get(target) ?? new Set<string>();
          refs.add(id);
          this.overlays.set(target, refs);
        }
      }
    }
    this.inputs = next;
    for (const [id, item] of deliveries) {
      const previous = this.deliveries.get(id);
      if (
        previous?.delivery !== item.delivery ||
        previous?.error !== item.error
      ) {
        if (messageKind(item.event.kind) && !affected.has(id))
          this.delivery(id, item);
      }
    }
    for (const id of this.deliveries.keys())
      if (!deliveries.has(id) && !affected.has(id))
        this.delivery(id, undefined);
    this.deliveries = deliveries;
    if (affected.size)
      this.profiling.measure(
        "view.fold",
        this.channelId,
        () => {
          for (const id of affected) {
            const event = next.get(id);
            const row =
              event && messageKind(event.kind)
                ? foldMessages(this.channelId, this.relayAuthor, [
                    event,
                    ...[...(this.overlays.get(id) ?? [])].flatMap(
                      (ref) => next.get(ref) ?? [],
                    ),
                  ])[0]
                : undefined;
            if (row)
              this.messages.set(id, this.withDelivery(row, deliveries.get(id)));
            else this.messages.delete(id);
          }
          this.rows = Object.freeze([...this.messages.values()].sort(order));
        },
        affected.size,
      );
    return this.rows;
  }
  private withDelivery(
    row: ChannelMessage,
    item: OutgoingEvent | undefined,
  ): ChannelMessage {
    return Object.freeze({
      ...row,
      delivery: item?.delivery,
      deliveryError: item?.error,
    });
  }
  private delivery(id: string, item: OutgoingEvent | undefined) {
    const row = this.messages.get(id);
    if (!row) return;
    const next = this.withDelivery(row, item);
    this.messages.set(id, next);
    this.rows = Object.freeze(
      this.rows.map((old) => (old.id === id ? next : old)),
    );
  }
}
