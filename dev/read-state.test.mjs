import { describe, expect, it } from "vitest";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip44,
} from "nostr-tools";
import {
  decodeReadState,
  signReadState,
  validReadStateEvent,
} from "./read-state.mjs";
const secret = generateSecretKey();
const blob = { v: 1, client_id: "fixture", contexts: { room: 12 } };
const intent = { slot: "a".repeat(32), createdAt: 100, blob };
describe("host-only read-state codec", () => {
  it("encrypts/signs only the own read-state coordinate and roundtrips without exposing a key", () => {
    const event = signReadState(intent, secret, 100);
    expect(event.kind).toBe(30078);
    expect(event.content).not.toContain("room");
    expect(decodeReadState([event], secret)).toEqual([
      { eventId: event.id, blob },
    ]);
  });
  it("rejects foreign authors, unrelated coordinates, changed signed bytes and invalid timestamps", () => {
    const event = signReadState(intent, secret, 100);
    expect(() => decodeReadState([event], generateSecretKey())).toThrow();
    expect(() =>
      validReadStateEvent({ ...event, content: "changed" }, secret),
    ).toThrow();
    expect(() =>
      signReadState({ ...intent, slot: "other" }, secret, 100),
    ).toThrow();
    expect(() => signReadState(intent, secret, 200)).toThrow();
    const unrelated = finalizeEvent(
      {
        kind: 30078,
        created_at: 100,
        tags: [["d", "channel-stars"]],
        content: "x",
      },
      secret,
    );
    expect(() => decodeReadState([unrelated], secret)).toThrow();
  });
  it("fails unknown schemas and decryption, rather than returning an empty state", () => {
    const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
    for (const content of [
      "broken",
      nip44.v2.encrypt(JSON.stringify({ ...blob, v: 2 }), key),
    ]) {
      const event = finalizeEvent(
        {
          kind: 30078,
          created_at: 100,
          tags: [
            ["d", `read-state:${intent.slot}`],
            ["t", "read-state"],
          ],
          content,
        },
        secret,
      );
      expect(() => decodeReadState([event], secret)).toThrow();
    }
    key.fill(0);
  });
  it("keeps explicit receive-event and aggregate bounds while publication validation stays smaller", () => {
    const small = signReadState(intent, secret, 100);
    const base = { ...small, tags: [...small.tags, ["padding", ""]] };
    const remaining = 96 * 1024 - Buffer.byteLength(JSON.stringify(base));
    const padded = (length) =>
      finalizeEvent(
        { ...small, tags: [...small.tags, ["padding", "x".repeat(length)]] },
        secret,
      );
    const event = padded(remaining);
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(96 * 1024);
    expect(decodeReadState(Array(4).fill(event), secret)).toEqual(
      Array(4).fill({ eventId: event.id, blob }),
    );
    expect(() => decodeReadState([padded(remaining + 1)], secret)).toThrow(
      "Invalid read-state event",
    );
    expect(() => decodeReadState(Array(6).fill(event), secret)).toThrow(
      "capacity",
    );
    expect(() => validReadStateEvent(event, secret)).toThrow(
      "Invalid read-state event",
    );
    expect(() =>
      decodeReadState([{ ...event, content: "changed" }], secret),
    ).toThrow();
  });
  it("bounds work before decrypting/signing", () => {
    expect(() => decodeReadState(Array(17).fill({}), secret)).toThrow(
      "capacity",
    );
    expect(() =>
      signReadState(
        {
          ...intent,
          blob: {
            ...blob,
            contexts: Object.fromEntries(
              Array.from({ length: 1000 }, (_, i) => [
                `key${i}${"a".repeat(100)}`,
                1,
              ]),
            ),
          },
        },
        secret,
        100,
      ),
    ).toThrow("capacity");
  });
});
