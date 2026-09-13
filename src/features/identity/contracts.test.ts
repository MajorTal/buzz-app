import { describe, expect, it } from "vitest";
import { errorCode, parseStatus } from "./contracts";
const valid = {
  state: "signedOut",
  pubkey: null,
  generation: "0",
  revocation: "00000000-0000-4000-8000-000000000001",
  busy: false,
  reason: null,
};
describe("public native snapshot", () => {
  it("accepts the documented snapshot and retains no unknown values", () => {
    expect(parseStatus(valid)).toEqual(valid);
    expect(Object.isFrozen(parseStatus(valid))).toBe(true);
    expect(
      parseStatus({
        ...valid,
        generation: "18446744073709551615",
        state: "unavailable",
        reason: "unavailable",
      }).generation,
    ).toBe("18446744073709551615");
  });
  it.each([
    null,
    [],
    { ...valid, extra: "secret" },
    { ...valid, generation: 0 },
    { ...valid, generation: "01" },
    { ...valid, generation: "-1" },
    { ...valid, generation: "18446744073709551616" },
    { ...valid, generation: "1e3" },
    { ...valid, revocation: "arbitrary text" },
    { ...valid, busy: null },
    { ...valid, state: "ready" },
    { ...valid, pubkey: "a".repeat(64) },
    { ...valid, reason: "raw credential error" },
    { ...valid, state: "ready", pubkey: "a".repeat(64), busy: true },
    { ...valid, state: "ready", pubkey: "a".repeat(64), reason: "denied" },
  ])("rejects malformed snapshot %# without echoing it", (value) => {
    expect(() => parseStatus(value)).toThrow(
      expect.objectContaining({ code: "unavailable" }),
    );
  });
  it("maps only stable error codes", () => {
    expect(errorCode({ code: "denied", message: "not for renderer" })).toBe(
      "denied",
    );
    expect(errorCode("sensitive error text")).toBe("unavailable");
  });
});
