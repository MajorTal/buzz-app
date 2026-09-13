import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";
import { eventDto } from "../src/features/relay/events.ts";
import {
  parseReadBlob,
  readCoordinate,
  READ_STATE_EVENT_BYTES,
  READ_STATE_PLAINTEXT_BYTES,
  record,
  slotId,
  uint32,
} from "../src/features/relay/read-state-model.ts";

export const READ_STATE_DECODE_BYTES = 512 * 1024;
// Original NIP-44 can expand 65,535 plaintext bytes to 87,472 base64 characters.
// Receive old client records without raising our 64 KiB publication event cap.
const READ_STATE_RECEIVE_EVENT_BYTES = 96 * 1024;
/** Validate and copy wire bytes: never trust nostr-tools' cached verification symbol. */
export function validReadStateEvent(
  raw,
  secret,
  maxBytes = READ_STATE_EVENT_BYTES,
) {
  const event = eventDto(raw);
  if (
    event.pubkey !== getPublicKey(secret) ||
    !readCoordinate(event) ||
    Buffer.byteLength(JSON.stringify(event)) > maxBytes
  )
    throw new Error("Invalid read-state event");
  return event;
}
export function decodeReadState(
  events,
  secret,
  maxEventBytes = READ_STATE_RECEIVE_EVENT_BYTES,
) {
  if (
    !Array.isArray(events) ||
    events.length > 16 ||
    Buffer.byteLength(JSON.stringify(events)) > READ_STATE_DECODE_BYTES
  )
    throw new Error("Read-state decode capacity exceeded");
  const verified = events.map((event) =>
    validReadStateEvent(event, secret, maxEventBytes),
  );
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return verified.map((event) => {
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (Buffer.byteLength(plaintext) > 128 * 1024)
        throw new Error("Read-state plaintext capacity exceeded");
      const blob = JSON.parse(plaintext);
      parseReadBlob(blob);
      return { eventId: event.id, blob };
    });
  } finally {
    key.fill(0);
  }
}
export function signReadState(
  raw,
  secret,
  now = Math.floor(Date.now() / 1000),
) {
  if (
    !record(raw) ||
    !slotId(raw.slot) ||
    !uint32(raw.createdAt) ||
    Math.abs(raw.createdAt - now) > 60
  )
    throw new Error("Invalid read-state signing intent");
  parseReadBlob(raw.blob);
  const plaintext = JSON.stringify(raw.blob);
  if (Buffer.byteLength(plaintext) > READ_STATE_PLAINTEXT_BYTES)
    throw new Error("Read-state publication capacity exceeded");
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    const event = finalizeEvent(
      {
        kind: 30078,
        created_at: raw.createdAt,
        tags: [
          ["d", `read-state:${raw.slot}`],
          ["t", "read-state"],
        ],
        content: nip44.v2.encrypt(plaintext, key),
      },
      secret,
    );
    return validReadStateEvent(event, secret);
  } finally {
    key.fill(0);
  }
}
