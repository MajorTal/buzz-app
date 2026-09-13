import { expect, it } from "vitest";
import { nip19 } from "nostr-tools";
import { publicKey, readSelection } from "./selection";
const pubkey = "a".repeat(64);
it("normalizes public hex and npub only", () => {
  expect(publicKey(`  ${pubkey.toUpperCase()} `)).toBe(pubkey);
  expect(publicKey(nip19.npubEncode(pubkey))).toBe(pubkey);
  expect(() => publicKey("nsec1synthetic")).toThrow(
    expect.objectContaining({ code: "invalidInput" }),
  );
  expect(() => publicKey("https://example.com/?npub=whatever")).toThrow();
});
it("ignores malformed/secret-shaped saved hints rather than treating them as authority", () => {
  for (const value of [
    "",
    "nsec1synthetic",
    '{"pubkey":"a"}',
    "x".repeat(100_000),
  ]) {
    expect(readSelection({ getItem: () => value, setItem() {} })).toBe("");
  }
});
