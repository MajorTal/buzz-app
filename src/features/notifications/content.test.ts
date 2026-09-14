import { expect, it } from "vitest";
import { messageNotificationText, messagePreview } from "./content";

const message = {
  channelId: "room",
  messageId: "b".repeat(64),
  authorId: "a".repeat(64),
  createdAt: 1,
  previewContent: "**Hello** [Wes](https://example.com/private)",
};
it.each([
  ["mention", "Pinky mentioned you in #new-notifications"],
  ["thread", "Pinky replied in #new-notifications"],
  ["direct", "Pinky sent you a direct message"],
] as const)(
  "formats %s with sender, conversation and plain preview",
  (category, title) => {
    expect(
      messageNotificationText(
        message,
        category,
        { id: "room", name: "new-notifications" },
        { name: "Pinky" },
      ),
    ).toEqual({ title, body: "Hello Wes" });
  },
);
it("DM mentions do not expose an internal DM name; missing names use key fragments", () => {
  expect(
    messageNotificationText(
      message,
      "mention",
      { id: "room", name: "internal-id", channelType: "dm" },
      undefined,
    ).title,
  ).toBe("aaaaaaaaaa mentioned you in a direct message");
  expect(
    messageNotificationText(message, "thread", undefined, { name: " " }).title,
  ).toBe("aaaaaaaaaa replied in #room");
});
it("flattens blocks, links, images, escapes and code without URLs or raw HTML", () => {
  expect(
    messagePreview(
      "# Heading\n\n**hello** [world](https://example.com)\n\n- one\n- two\n\n`a_b` ![private alt](https://example.com/image)\n\n<div>hidden</div>",
    ),
  ).toBe("Heading hello world one two a_b [Image]");
  expect(
    messagePreview("[label][ref]\n\n[ref]: https://example.com/private"),
  ).toBe("label");
  expect(
    messagePreview("\\*literal\\* &amp; `code`\n\n```js\nconst a = 1;\n```"),
  ).toBe("*literal* & code const a = 1;");
});
it("bounds source, Unicode output and nesting, with a nonempty fallback", () => {
  expect(messagePreview("😀".repeat(400))).toBe(`${"😀".repeat(199)}…`);
  expect(messagePreview(`${" ".repeat(4096)}not parsed`)).toBe("New message");
  expect(messagePreview(`${"> ".repeat(120)}deep`)).toBe("New message");
  expect(messagePreview("<div>hidden</div>")).toBe("New message");
});
it("normalizes whitespace/control characters in names and body", () => {
  const text = messageNotificationText(
    { ...message, previewContent: "hello\u202E\nworld" },
    "mention",
    { id: "room", name: "room\nname" },
    { name: "Pinky\u202E\nMouse" },
  );
  expect(text).toEqual({
    title: "Pinky Mouse mentioned you in #room name",
    body: "hello world",
  });
  expect(
    messageNotificationText(
      message,
      "mention",
      { id: "room", name: "y".repeat(200) },
      { name: "x".repeat(200) },
    ).title,
  ).toBe(`${"x".repeat(63)}… mentioned you in #${"y".repeat(63)}…`);
});
