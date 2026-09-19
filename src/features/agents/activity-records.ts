type Record = Readonly<{
  id: string;
  agent: string;
  receivedAt: number;
  kind: string;
  plaintext: string;
}>;
export type ActivityRecord = Record & Readonly<{ envelopeId: string }>;
const object = (value: unknown): { [key: string]: unknown } | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { [key: string]: unknown })
    : undefined;

/** Filter individual batch children, never relabel a mixed envelope as one channel.
 * Raw session retention is unchanged; child JSON is a display projection. */
export function activityRecords(
  records: readonly Record[],
  agent: string,
  channelId = "",
): ActivityRecord[] {
  return records.flatMap((record) => {
    if (record.agent !== agent) return [];
    if (!channelId) return [{ ...record, envelopeId: record.id }];
    let raw: unknown;
    try {
      raw = JSON.parse(record.plaintext);
    } catch {
      return [];
    }
    const envelope = object(raw);
    if (envelope?.kind !== "batch")
      return envelope?.channelId === channelId
        ? [{ ...record, envelopeId: record.id }]
        : [];
    const children = object(envelope.payload)?.events;
    if (!Array.isArray(children)) return [];
    return children.flatMap((child, index) => {
      const item = object(child);
      if (item?.channelId !== channelId) return [];
      return [
        {
          ...record,
          id: `${record.id}:${index}`,
          envelopeId: record.id,
          kind: typeof item.kind === "string" ? item.kind : "unknown",
          plaintext: JSON.stringify(child, null, 2),
        },
      ];
    });
  });
}
