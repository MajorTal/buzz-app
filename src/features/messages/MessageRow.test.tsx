import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { foldMessages } from "../relay/fold";
import { keypair, message, signed } from "../relay/testing";
import { MessageRow } from "./MessageRow";
import type { ChannelMessage } from "../relay/contracts";
import type { UnreadCapability, UnreadSnapshot } from "../relay/unread";

const row: ChannelMessage = {
  id: "root",
  channelId: "channel",
  authorId: "author",
  content: "Root",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 23,
};

it("combines directional groups with Markdown, profile access, and thread actions", () => {
  const author = "a".repeat(64);
  const sample = (viewer: string, groupEnd: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          authorId: author,
          content: "**Important** reply",
          replyCount: 0,
        }}
        viewer={viewer}
        continuation
        groupEnd={groupEnd}
        profile={{ name: "Author" }}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => true}
        onOpenThread={() => {}}
        day={false}
        retry={undefined}
      />,
    );
  const incoming = sample("other", true);
  expect(incoming).toContain('data-bubble-direction="incoming"');
  expect(incoming).toContain("<strong>Important</strong>");
  expect(incoming).toContain('aria-label="View Author profile"');
  expect(incoming).toContain('aria-label="Reply in thread"');
  expect(sample("other", false)).not.toContain(
    'aria-label="View Author profile"',
  );
  const outgoing = sample(author, true);
  expect(outgoing).toContain('data-bubble-direction="outgoing"');
  expect(outgoing).not.toContain('aria-label="View Author profile"');
});
function render(
  patch: Partial<UnreadSnapshot>,
  replies = 23,
  clickable = true,
  threadRootId?: string,
) {
  const snapshot = vi.fn(() => ({
    observedCount: null,
    manual: "none",
    ...patch,
  }));
  const unread = { snapshot } as unknown as UnreadCapability;
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, replyCount: replies, threadRootId }}
      unread={unread}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={clickable ? () => {} : undefined}
    />,
  );
  return { html, snapshot };
}
it("selects this thread, adds an accessible unread cue and preserves the total reply count", () => {
  const { html, snapshot } = render({ observedCount: 2 });
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "root",
  });
  expect(html).toContain(
    'aria-label="View thread: 23 replies. Observed unread replies. Not an exact total."',
  );
  expect(html).toContain(
    'aria-hidden="true" title="Observed unread replies. Not an exact total."',
  );
  expect(html).toContain("23 replies</span>");
});
it.each([null, 0])(
  "omits the dot for %s observed replies, not a fabricated unread total",
  (observedCount) => {
    const { html } = render({ observedCount });
    expect(html).toContain('aria-label="View thread: 23 replies"');
    expect(html).not.toContain('title="Observed unread replies');
  },
);
it("describes local manual intent and stale evidence honestly", () => {
  expect(render({ manual: "local-only", observedCount: 0 }).html).toContain(
    "Thread marked unread on this device only",
  );
  expect(render({ manual: "remote", observedCount: 0 }).html).toContain(
    "Thread marked unread",
  );
  expect(render({ observedCount: 1, freshness: "stale" }).html).toContain(
    "Observed unread replies; may be out of date",
  );
});
it("does not select unread for rows without a thread button", () => {
  expect(render({}, 0).snapshot).not.toHaveBeenCalled();
  expect(render({}, 23, false).snapshot).not.toHaveBeenCalled();
});

it("selects the opening root for a broadcast reply instead of its own row ID", () => {
  const { snapshot } = render({ observedCount: 1 }, 23, true, "original-root");
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "original-root",
  });
});

it("renders exact identity controls only while a target can be opened", () => {
  const author = "a".repeat(64),
    recipient = "b".repeat(64);
  const renderProfile = (enabled: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          authorId: author,
          content: "Hello @Mic",
          mentions: [recipient],
        }}
        profile={{ name: "Author" }}
        participantProfiles={new Map([[recipient, { name: "Mic" }]])}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => enabled}
        day={false}
        retry={undefined}
      />,
    );
  const enabled = renderProfile(true);
  expect(enabled).toContain('aria-label="View Author profile"');
  expect(enabled).toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain(
    'aria-label="View Author profile"',
  );
  expect(renderProfile(false)).toContain("@Mic");
});

it.each([
  "    @Mic\n\nOutside @Mic",
  '```js\nconst delimiter = "```";\n@Mic\n```\nOutside @Mic',
  "~~~js\nconst delimiter = '~~~';\n@Mic\n~~~\nOutside @Mic",
])("only exposes the prose mention through MessageRow: %s", (content) => {
  const recipient = "b".repeat(64);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, content, mentions: [recipient] }}
      profile={undefined}
      participantProfiles={new Map([[recipient, { name: "Mic" }]])}
      media={() => undefined}
      onOpenLink={() => true}
      canOpenLink={() => true}
      day={false}
      retry={undefined}
    />,
  );
  expect(html.match(/aria-label="View Mic profile"/g)).toHaveLength(1);
  expect(html.indexOf('aria-label="View Mic profile"')).toBeGreaterThan(
    html.indexOf("Outside "),
  );
});

it.each([9, 40002])(
  "does not manufacture profile bindings when kind %s images are removed",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of [
      "@M![x][image]ic\n\n[image]: https://example.test/a.png",
      "@M![x](https://example.test/a.png)ic",
      "@M![x](http://example.test/a.png)ic",
      "@![x](https://example.test/a.png)Mic",
      "Hello @Mic ![x](https://example.test/a.png)",
    ]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      expect(folded.content).toContain("@Mic");
      expect(folded.attachmentContentRemoved).toBe(true);
      expect(folded.mentions).toEqual([recipient.pubkey]);
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(html).toContain("@Mic");
    }
    const [unchanged] = foldMessages("channel", relay.pubkey, [
      message(author, "channel", "@Mic  \n", 1),
    ]);
    expect(unchanged?.attachmentContentRemoved).toBeUndefined();
  },
);

it.each([9, 40002])(
  "preserves signed kind %s code indentation through fold and render",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of ["    @Mic", "\t@Mic"]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(folded.content).toBe(content);
    }
  },
);

it.each([
  [
    { width: 700, height: 900 },
    "width:248.88888888888889px;aspect-ratio:700 / 900",
  ],
  [{ width: 1600, height: 900 }, "width:360px;aspect-ratio:1600 / 900"],
  [{ width: 20, height: 10 }, "width:20px;aspect-ratio:20 / 10"],
])(
  "reserves metadata-sized previews without waiting for load: %j",
  (dimensions, style) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          attachments: [
            { url: "https://image.test/shot.png", video: false, dimensions },
          ],
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(`style="${style}"`);
    expect(html).toContain('aria-label="Open image attachment"');
    expect(html).toContain('loading="lazy"');
  },
);

it("does not bypass the session media resolver to paint an inaccessible attachment", () => {
  const media = vi.fn(() => undefined);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://image.test/original.png",
            video: false,
            blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
          },
        ],
      }}
      profile={undefined}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(media).toHaveBeenCalledWith("https://image.test/original.png");
  expect(html).toContain("Image attachment");
  expect(html).not.toContain("<canvas");
  expect(html).not.toContain("<img");
});
