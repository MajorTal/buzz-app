import { expect, it } from "vitest";
import { geometryFor, geometrySignature } from "./geometry";
import { createRelaySession } from "../relay/session";
import { foldMessages } from "../relay/fold";
import { keypair, message } from "../relay/testing";

it("invalidates geometry for changed content, profiles, width, session, and history eviction", () => {
  const first = createRelaySession(null),
    second = createRelaySession(null);
  const a = geometryFor(first.session.channels),
    b = geometryFor(second.session.channels);
  const cache = [[100, 200], 150] as unknown as Parameters<typeof a.set>[3];
  a.set("a", "v1", 900, cache);
  expect(a.get("a", "v1", 900)).toBe(cache);
  expect(a.get("a", "v2", 900)).toBeUndefined();
  expect(a.get("a", "v1", 901)).toBeUndefined();
  expect(b.get("a", "v1", 900)).toBeUndefined();
  for (const id of ["b", "c", "d"]) a.set(id, "v1", 900, cache);
  expect(a.get("a", "v1", 900)).toBeUndefined();
  const author = keypair();
  const rows = foldMessages("a", "relay", [message(author, "a", "hello", 20)]);
  expect(geometrySignature(rows, new Map())).not.toBe(
    geometrySignature(rows, new Map([[author.pubkey, { name: "Author" }]])),
  );
  expect(geometrySignature(rows, new Map(), author.pubkey)).not.toBe(
    geometrySignature(rows, new Map(), "another-viewer"),
  );
  const edited = rows.map((row) => ({ ...row, content: "edited" }));
  expect(geometrySignature(rows, new Map())).not.toBe(
    geometrySignature(edited, new Map()),
  );
  first.dispose();
  second.dispose();
});
