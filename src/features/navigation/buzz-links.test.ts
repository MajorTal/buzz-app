import { expect, it } from "vitest";
import {
  buzzLinkKind,
  buzzLinkTarget,
  isBuzzLink,
  parseBuzzLink,
} from "./buzz-links";
import { targetLink } from "./targets";

const scope = {
  viewer: "a".repeat(64),
  communityOrigin: "https://community.example",
};
const example =
  "buzz://message?channel=c89a3185-29c5-40db-8284-054536d98b09&id=9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b";
it("recognizes the reported message link and binds it to the receiving community and viewer", () => {
  expect(buzzLinkKind(example)).toBe("message");
  expect(buzzLinkTarget(example, scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "c89a3185-29c5-40db-8284-054536d98b09",
    messageId:
      "9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b",
  });
  expect(buzzLinkKind(`${example}&thread=${"b".repeat(64)}`)).toBe("thread");
});
it("supports channels and leaves shared-link community ownership intact", () => {
  expect(buzzLinkKind("buzz://channel/general")).toBe("channel");
  expect(buzzLinkTarget("buzz://channel/general", scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "general",
  });
  const shared = targetLink({
    version: 1,
    kind: "conversation",
    scope: {
      ...scope,
      viewer: "b".repeat(64),
      communityOrigin: "https://other.example",
    },
    channelId: "general",
  });
  expect(buzzLinkKind(shared)).toBe("channel");
  expect(buzzLinkTarget(shared, scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope: { ...scope, communityOrigin: "https://other.example" },
    channelId: "general",
  });
});
it.each([
  "buzz://channel/",
  "buzz://channel/general/extra",
  "buzz://channel/general?relay=evil",
  "buzz://channel/%2Fprivate",
  "buzz://channel/%ZZ",
  "buzz://user@channel/general",
  "buzz://channel:443/general",
  "buzz://message?channel=general&id=bad",
  `${example}&id=${"b".repeat(64)}`,
  `${example}&thread=bad`,
  `${example}&viewer=${"b".repeat(64)}`,
  `${example}#fragment`,
  "buzz://message/extra?channel=general",
  "buzz://join?relay=example",
  "javascript:alert(1)",
])("leaves unsupported or malformed links inert: %s", (href) => {
  expect(parseBuzzLink(href)).toBeNull();
});
it("classifies the buzz scheme case-insensitively, matching URL normalization", () => {
  // The activation boundaries must agree with parseBuzzLink, which normalizes
  // the scheme via `new URL`; a mixed-case link must not fall through to
  // external `_blank` handling.
  expect(isBuzzLink("buzz://channel/general")).toBe(true);
  expect(isBuzzLink("BUZZ://channel/general")).toBe(true);
  expect(isBuzzLink("Buzz://message?channel=general&id=x")).toBe(true);
  expect(isBuzzLink(example)).toBe(true);
  expect(isBuzzLink("https://example.com")).toBe(false);
  expect(isBuzzLink("javascript:alert(1)")).toBe(false);
  expect(isBuzzLink("not a url")).toBe(false);
});
