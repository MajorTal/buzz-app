import { expect, it } from "vitest";
import {
  buzzLinkKind,
  buzzLinkTarget,
  isBuzzLink,
  parseBuzzLink,
} from "./buzz-links";
import { deepLinkStep } from "./deep-links";

const scope = {
  viewer: "a".repeat(64),
  communityOrigin: "https://community.example",
};
const example =
  "buzz://message?channel=c89a3185-29c5-40db-8284-054536d98b09&id=9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b";
it("resolves the desktop channel/message alias, including UUID v7 and uppercase event IDs", () => {
  const channelId = "018fdb5d-3a64-7c35-b5f9-4a23e1f9d2d9";
  const href = `buzz://channel/${channelId}/${"B".repeat(64)}`;
  expect(buzzLinkKind(href)).toBe("message");
  expect(buzzLinkTarget(href, scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId,
    messageId: "b".repeat(64),
  });
  expect(
    deepLinkStep(href, {
      viewer: scope.viewer,
      selected: scope.communityOrigin,
    }),
  ).toEqual({ open: buzzLinkTarget(href, scope) });
});
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
it("supports channel links and binds them to the receiving community", () => {
  expect(buzzLinkKind("buzz://channel/general")).toBe("channel");
  expect(buzzLinkTarget("buzz://channel/general", scope)).toEqual({
    version: 1,
    kind: "conversation",
    scope,
    channelId: "general",
  });
});
it("does not treat the retired buzz://open locator as a Buzz link, however well-formed", () => {
  // A JSON navigation target behind `buzz://open?target=` was this app's own
  // in-app locator. It is not a Buzz link form and is now an unknown host.
  const home =
    "buzz://open?target=%7B%22version%22%3A1%2C%22kind%22%3A%22home%22%7D";
  const scoped = `buzz://open?target=%7B%22version%22%3A1%2C%22kind%22%3A%22conversation%22%2C%22scope%22%3A%7B%22communityOrigin%22%3A%22https%3A%2F%2Fother.example%22%7D%2C%22channelId%22%3A%22design%22%2C%22messageId%22%3A%22${"b".repeat(64)}%22%7D`;
  for (const href of [home, scoped]) {
    expect(isBuzzLink(href)).toBe(true);
    expect(parseBuzzLink(href)).toBeNull();
    expect(buzzLinkKind(href)).toBeNull();
    expect(buzzLinkTarget(href, scope)).toBeNull();
  }
});
it("ignores query parameters outside the Buzz link grammar, as the original desktop client does", () => {
  const thread = "b".repeat(64);
  const parsed = {
    format: "legacy",
    channelId: "c89a3185-29c5-40db-8284-054536d98b09",
    messageId:
      "9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b",
  };
  const withUnknown = `${example}&thread=${thread}&foo=bar`;
  expect(parseBuzzLink(withUnknown)).toEqual({
    ...parsed,
    threadRootId: thread,
  });
  expect(buzzLinkKind(withUnknown)).toBe("thread");
  expect(
    deepLinkStep(withUnknown, {
      viewer: scope.viewer,
      selected: scope.communityOrigin,
    }),
  ).toEqual({
    open: {
      version: 1,
      kind: "conversation",
      scope,
      channelId: parsed.channelId,
      messageId: parsed.messageId,
      threadRootId: thread,
    },
  });
  // Unknown keys are dropped with their values and repeats, wherever they sit.
  expect(parseBuzzLink(`${example}&foo=1&foo=2`)).toEqual(parsed);
  expect(parseBuzzLink(`${example}&viewer=${"b".repeat(64)}`)).toEqual(parsed);
  expect(
    parseBuzzLink(
      `buzz://message?foo=bar&channel=${parsed.channelId}&relay=evil&id=${parsed.messageId}`,
    ),
  ).toEqual(parsed);
  // The channel forms carry everything in the path and ignore any query.
  expect(parseBuzzLink("buzz://channel/general?relay=evil")).toEqual({
    format: "legacy",
    channelId: "general",
  });
  expect(parseBuzzLink(`buzz://channel/general/${thread}?foo=bar`)).toEqual({
    format: "legacy",
    channelId: "general",
    messageId: thread,
  });
  // A duplicated known key is ambiguous and still rejects.
  expect(
    parseBuzzLink(`buzz://message?channel=a&channel=b&id=${parsed.messageId}`),
  ).toBeNull();
  expect(parseBuzzLink(`${example}&thread=${thread}&thread=${thread}`)).toBe(
    null,
  );
});
it.each([
  "buzz://channel/",
  "buzz://channel/general/extra",
  "buzz://channel/general/",
  `buzz://channel/general/${"a".repeat(64)}/extra`,
  `buzz://channel/general%2F${"a".repeat(64)}`,
  "buzz://channel/%2Fprivate",
  "buzz://channel/%ZZ",
  "buzz://user@channel/general",
  "buzz://channel:443/general",
  "buzz://message?channel=general&id=bad",
  `${example}&id=${"b".repeat(64)}`,
  `${example}&thread=bad`,
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
