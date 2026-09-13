import { test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import { decodeAgentObserver } from "./agent-observer.mjs";

const now = 1700000000;
// Keep frame construction and validation in the same second at the ±300s boundary.
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000 + 999);
});
afterEach(() => vi.restoreAllMocks());

const owner = generateSecretKey(),
  agent = generateSecretKey(),
  stranger = generateSecretKey();
const viewer = getPublicKey(owner),
  sender = getPublicKey(agent);
const raw = JSON.stringify({
  kind: "acp_read",
  channelId: null,
  sessionId: null,
  turnId: null,
  seq: 1,
  timestamp: new Date(now * 1000).toISOString(),
  payload: { text: "<script>not markup</script>" },
});
function frame(patch = {}, plaintext = raw) {
  return finalizeEvent(
    {
      kind: 24200,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", viewer],
        ["agent", sender],
        ["frame", "telemetry"],
      ],
      content: nip44.v2.encrypt(
        plaintext,
        nip44.v2.utils.getConversationKey(agent, viewer),
      ),
      ...patch,
    },
    agent,
  );
}
test("purpose-bound host decoder preserves raw JSON and never returns keys", () => {
  const event = frame();
  expect(decodeAgentObserver(event, owner, viewer)).toEqual({
    id: event.id,
    agent: sender,
    createdAt: event.created_at,
    plaintext: raw,
  });
});
test("rejects signature, recipient, sender, direction, cardinality, freshness, content and captured-viewer violations", () => {
  const tags = frame().tags;
  const invalid = [
    { ...frame(), sig: "0".repeat(128) },
    frame({ kind: 9 }),
    frame({ tags: [["p", getPublicKey(stranger)], ...tags.slice(1)] }),
    frame({ tags: [tags[0], ["agent", viewer], tags[2]] }),
    frame({ tags: [tags[0], tags[1], ["frame", "control"]] }),
    ...tags.map((tag) => frame({ tags: [...tags, tag] })),
    frame({ tags: [["p", viewer, "extra"], ...tags.slice(1)] }),
    frame({ content: "x" }),
    frame({ content: "x".repeat(87473) }),
    frame({ created_at: Math.floor(Date.now() / 1000) - 301 }),
    frame({ created_at: Math.floor(Date.now() / 1000) + 301 }),
    frame({}, "not JSON"),
  ];
  for (const event of invalid)
    expect(() => decodeAgentObserver(event, owner, viewer)).toThrow();
  expect(() => decodeAgentObserver(frame(), stranger, viewer)).toThrow();
  // Cached verification symbols from finalizeEvent must not bypass verification.
  const cached = frame();
  cached.content = frame({}, "{}").content;
  expect(() => decodeAgentObserver(cached, owner, viewer)).toThrow();
});
