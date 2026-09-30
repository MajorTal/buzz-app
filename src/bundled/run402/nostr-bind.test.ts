import { expect, it } from "vitest";
import { parseNostrBindRequest } from "./nostr-bind";

const origin = "https://buzz-todo.run402.com";
const now = Date.parse("2026-09-30T12:00:00.000Z");
const fields = {
  challenge_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  nonce: `${"A".repeat(42)}_`,
  verification_code: "042317",
  audience: "buzz:nostr-identity",
  action: "bind_nostr_identity",
  protocol: "buzz-nostr-identity",
  version: "1",
  origin,
  expires_at: "2026-09-30T12:05:00.000Z",
  return: "browser_fragment_v1",
  callback_url: `${origin}/callback`,
};
function bindLink(overrides: Record<string, string | undefined> = {}) {
  const url = new URL("buzz://nostr-bind");
  for (const [name, value] of Object.entries({ ...fields, ...overrides }))
    if (value !== undefined) url.searchParams.set(name, value);
  return url.toString();
}

it("binds a well-formed link to the framed origin as the nine signed tags, verbatim", () => {
  expect(parseNostrBindRequest(bindLink(), origin, now)).toEqual({
    challengeId: fields.challenge_id,
    expiresAt: fields.expires_at,
    tags: [
      ["challenge_id", fields.challenge_id],
      ["nonce", fields.nonce],
      ["verification_code", "042317"],
      ["audience", "buzz:nostr-identity"],
      ["action", "bind_nostr_identity"],
      ["protocol", "buzz-nostr-identity"],
      ["version", "1"],
      ["origin", origin],
      ["expires_at", fields.expires_at],
    ],
  });
  expect(
    parseNostrBindRequest(
      bindLink({ return: "clipboard", callback_url: undefined }),
      origin,
      now,
    ),
  ).toMatchObject({
    challengeId: fields.challenge_id,
    tags: expect.any(Array),
  });
});

it("rejects a challenge for any origin other than the one actually framed", () => {
  const invalid = { challengeId: fields.challenge_id, error: "invalid" };
  for (const claimed of [
    "https://evil.run402.com",
    `${origin}/`,
    "http://buzz-todo.run402.com",
    "https://buzz-todo.run402.com:444",
  ])
    expect(
      parseNostrBindRequest(bindLink({ origin: claimed }), origin, now),
    ).toEqual(invalid);
  expect(
    parseNostrBindRequest(bindLink(), "https://other.run402.com", now),
  ).toEqual(invalid);
});

it("requires the callback on the same origin, without credentials", () => {
  for (const callback_url of [
    "https://evil.example/callback",
    "http://buzz-todo.run402.com/callback",
    "https://user:pw@buzz-todo.run402.com/callback",
    "not a url",
    undefined,
  ])
    expect(
      parseNostrBindRequest(bindLink({ callback_url }), origin, now),
    ).toMatchObject({ error: "invalid" });
});

it("answers an expired challenge as expired and a far-future one as invalid", () => {
  expect(
    parseNostrBindRequest(
      bindLink({ expires_at: "2026-09-30T11:59:59Z" }),
      origin,
      now,
    ),
  ).toEqual({ challengeId: fields.challenge_id, error: "expired" });
  expect(
    parseNostrBindRequest(
      bindLink({ expires_at: "2026-10-01T12:00:00Z" }),
      origin,
      now,
    ),
  ).toMatchObject({ error: "invalid" });
});

it("rejects wrong fixed fields, malformed values and other link shapes", () => {
  for (const overrides of [
    { audience: "buzz:other" },
    { action: "transfer" },
    { protocol: "nostr-connect" },
    { version: "2" },
    { nonce: "short" },
    { verification_code: "12345" },
    { expires_at: "tomorrow" },
    { return: "somewhere" },
  ])
    expect(
      parseNostrBindRequest(bindLink(overrides), origin, now),
    ).toMatchObject({ error: "invalid" });
  expect(
    parseNostrBindRequest(
      bindLink().replace("buzz://nostr-bind", "buzz://connect"),
      origin,
      now,
    ),
  ).toMatchObject({ error: "invalid" });
  expect(
    parseNostrBindRequest(
      `${bindLink()}&verification_code=999999`,
      origin,
      now,
    ),
  ).toMatchObject({ error: "invalid" });
  // Nothing to answer without a challenge.
  expect(parseNostrBindRequest("not a link", origin, now)).toBeUndefined();
  expect(
    parseNostrBindRequest(bindLink({ challenge_id: undefined }), origin, now),
  ).toBeUndefined();
  expect(
    parseNostrBindRequest(
      bindLink({ challenge_id: "not-a-uuid" }),
      origin,
      now,
    ),
  ).toMatchObject({ error: "invalid" });
});
