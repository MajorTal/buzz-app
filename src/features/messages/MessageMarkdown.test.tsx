import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import type {
  ConversationExtensions,
  InlineRenderer,
} from "../conversation/contracts";
import type { Contribution } from "../../plugins/contributions";
import { CustomEmoji } from "../../bundled/emoji/CustomEmoji";
import { emojiMatches } from "../relay/emoji";
import { profileTarget } from "../profiles/target";
import styles from "./Messages.module.css";
import { LinkLabel } from "../../bundled/links/InlineLink";
import { MessageMarkdown } from "./MessageMarkdown";
import { safeMessageUrl } from "../relay/message-content";
import type { ChannelMessage } from "../relay/contracts";

const mic = "b".repeat(64),
  smith = "a".repeat(64),
  other = "c".repeat(64);
const profiles = new Map([
  [mic, { name: "Mic" }],
  [smith, { name: "Mic Smith" }],
  [other, { name: "Other" }],
]);
type RenderOptions = Partial<
  Omit<ComponentProps<typeof MessageMarkdown>, "row">
> & {
  emoji?: ChannelMessage["emoji"];
  patch?: Partial<ChannelMessage>;
};
function props(
  content: string,
  { emoji = [], patch, ...options }: RenderOptions = {},
): ComponentProps<typeof MessageMarkdown> {
  return {
    row: {
      id: "message",
      channelId: "channel",
      authorId: "author",
      content,
      createdAt: 1,
      mentions: [mic, smith],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      emoji,
      ...patch,
    },
    media: () => undefined,
    onOpenLink: () => false,
    canOpenLink: () => true,
    participantProfiles: profiles,
    ...options,
  };
}
function render(content: string, options: RenderOptions = {}) {
  return renderToStaticMarkup(<MessageMarkdown {...props(content, options)} />);
}

// Invoke the real parser and component callbacks for handler evidence, without
// replacing Markdown or claiming this server-side test establishes DOM focus.
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function profileButtons(content: string, options: RenderOptions = {}) {
  const rendered = elements(MessageMarkdown(props(content, options)));
  const markdown = rendered.find((node) => node.type === Markdown);
  if (!markdown) throw new Error("Missing Markdown");
  const parsed = Markdown(markdown.props as ComponentProps<typeof Markdown>);
  const Span = (markdown.props.components as Components).span;
  const renderSpan = (
    rendered.find((node) =>
      Boolean((node.props.value as Components | undefined)?.span),
    )?.props.value as Components | undefined
  )?.span as (props: ComponentProps<"span">) => ReactNode;
  if (typeof renderSpan !== "function")
    throw new Error("Missing inline renderer");
  return elements(parsed)
    .filter((node) => node.type === Span)
    .flatMap((node) => elements(renderSpan(node.props)))
    .filter((node) => node.type === "button");
}

const party = {
  shortcode: "party_parrot",
  url: "https://emoji.test/party.png",
};
const emojiRenderer: Contribution<InlineRenderer> = {
  id: "emoji",
  key: "test/emoji",
  pluginId: "test",
  revision: "1",
  title: "Emoji",
  matches: ({ text, message }) => [...emojiMatches(text, message.emoji ?? [])],
  component: ({ media }) => <CustomEmoji emoji={party} media={media} />,
};
const pluginRenderer: Contribution<InlineRenderer> = {
  id: "word",
  key: "test/word",
  pluginId: "test",
  revision: "1",
  title: "Word",
  matches: ({ text }) =>
    [...text.matchAll(/PLUGIN/g)].map((match) => ({
      start: match.index,
      end: match.index + 6,
    })),
  component: ({ text }) => <mark>{text}</mark>,
};
const extensions: ConversationExtensions = {
  tools: { snapshot: () => [], subscribe: () => () => {} },
  inline: {
    snapshot: () => [emojiRenderer, pluginRenderer],
    subscribe: () => () => {},
  },
};

describe("MessageMarkdown", () => {
  it("renders compact CommonMark and GFM structure with chat line breaks", () => {
    const html = render(`# Heading
first
second

- one
- two

~~done~~

> quote

| A | B |
| - | - |
| 1 | 2 |

- [x] checked`);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("first<br/>\nsecond");
    expect(html).toContain("<ul>");
    expect(html).toContain("<del>done</del>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox" disabled="" checked=""');
  });

  it("renders inline and fenced code without parsing markdown inside it", () => {
    const html = render("`**literal** :party:`\n\n```ts\nconst x = 1\n```");
    expect(html).toContain("<code>**literal** :party:</code>");
    expect(html).toContain('<code class="language-ts">const x = 1');
    expect(html).not.toContain("<strong>literal</strong>");
  });

  it("keeps raw HTML inert and never renders markdown images", () => {
    const html = render(
      '<script>alert("x")</script>\n\nbefore <b>raw</b> ![remote alt](https://images.test/a.png)',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toContain("remote alt");
  });

  it("allows credential-free HTTPS links and makes other destinations non-clickable", () => {
    expect(safeMessageUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
    for (const url of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///tmp/x",
      "/relative",
      "https://user:secret@example.com",
    ])
      expect(safeMessageUrl(url)).toBeUndefined();

    const safe = render("[Example](https://example.com/path)");
    expect(safe).toContain('href="https://example.com/path"');
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener noreferrer"');
    expect(safe).toContain('title="https://example.com/path"');

    const unsafe = render("[bad](javascript:alert(1)) [local](/relative)");
    expect(unsafe).not.toContain("<a");
    expect(unsafe).toContain("bad");
    expect(unsafe).toContain("local");
  });

  it("falls back to literal text before recursively rendering deeply nested inbound content", () => {
    const html = render(`${"> ".repeat(20_000)}**literal deep message**`);
    expect(html).toContain("**literal deep message**");
    expect(html).not.toContain("<blockquote>");
    expect(html).not.toContain("<strong>");
  });

  it("falls back to literal text for exceptionally large inbound content", () => {
    const html = render(`${"a".repeat(100_001)} **not parsed**`);
    expect(html).toContain("**not parsed**");
    expect(html).not.toContain("<strong>");
  });
});

describe("Markdown profile mentions", () => {
  it("binds exact signed names longest-first through surrounding emphasis", () => {
    const html = render("**@Mic Smith**, _@Mic_! @Other @Missing @Microscopic");
    expect(html).toContain("<strong><button");
    expect(html).toContain('aria-label="View Mic Smith profile"');
    expect(html).toContain("</svg>Mic Smith</button></strong>");
    // The raw helper conservatively treats trailing underscore as a name suffix.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("<em>@Mic</em>");
    const emphasized = render("*@Mic* ~~@Mic Smith~~");
    expect(emphasized).toContain("<em><button");
    expect(emphasized).toContain("<del><button");
  });

  it("keeps Markdown punctuation within a signed display name exact", () => {
    const name = "M*ic* _Smith_ :party_parrot:";
    const html = render(`**@${name}**`, {
      participantProfiles: new Map([[mic, { name }]]),
      emoji: [party],
      extensions,
    });
    expect(html).toContain(`aria-label="View ${name} profile"`);
    expect(html).toContain(`</svg>${name}</button></strong>`);
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<img");
  });

  it.each(["Mic `code`", "Mic [link](https://example.test)"])(
    "never lets a matching profile name consume non-prose: %s",
    (name) => {
      const html = render(`@${name}`, {
        participantProfiles: new Map([[mic, { name }]]),
      });
      expect(html).not.toContain("<button");
      expect(html).toMatch(/<code>|<a /);
    },
  );

  it("focuses the clicked mention before opening its exact profile target", () => {
    const calls: string[] = [];
    const canOpenLink = vi.fn((_target: string) => true);
    const buttons = profileButtons("**@Mic Smith** then @Mic", {
      canOpenLink,
      onOpenLink: (target) => {
        calls.push(target);
        return true;
      },
    });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      (button.props.onClick as (event: unknown) => void)({
        currentTarget: { focus: () => calls.push("focus") },
      });
    }
    expect(calls).toEqual([
      "focus",
      profileTarget(smith),
      "focus",
      profileTarget(mic),
    ]);
    expect(canOpenLink.mock.calls.map(([target]) => target)).toEqual([
      profileTarget(smith),
      profileTarget(mic),
    ]);
  });

  it.each([
    "`https://example.test @Mic`",
    "`` a ` @Mic ``",
    "```ts\n@Mic\n```",
    "~~~\n@Mic\n~~~",
    "`unfinished @Mic",
    "```\n@Mic",
    "    @Mic",
    "\t@Mic",
    "intro\n    @Mic",
    "email@Mic",
    "https://example.test/@Mic",
    "http://example.test/@Mic",
    "[label @Mic](https://example.test)",
    "![alt @Mic](https://example.test)",
    "[@Mic][reference]\n\n[reference]: https://example.test",
    "[@Mic][]\n\n[@Mic]: https://example.test",
    "[@Mic]\n\n[@Mic]: https://example.test",
    "[**@Mic**](https://example.test)",
    "<https://example.test/@Mic>",
    "www.example.test/@Mic",
    "\\@Mic",
    "&#64;Mic",
    "@M&#105;c",
    "@Mic_foo",
    "@Micé",
    `@Mic (${other})`,
  ])(
    "does not create profile controls from excluded raw context: %s",
    (content) => {
      const html = render(content);
      expect(html).not.toContain("<button");
      expect(html).not.toMatch(/[\uE000-\uE002]/);
    },
  );

  it.each([
    "`https://example.test @Mic` then @Mic",
    "    @Mic\n\nOutside @Mic",
    "intro\n    @Mic\nOutside @Mic",
    '```js\nconst marker = "```";\n@Mic\n```\nOutside @Mic',
    "````\n```\n@Mic\n````\nOutside @Mic",
  ])(
    "evaluates full-body exclusions while retaining subsequent prose: %s",
    (content) => {
      const html = render(content);
      expect(html.match(/aria-label="View Mic profile"/g)).toHaveLength(1);
      expect(html.lastIndexOf("<button")).toBeGreaterThan(html.indexOf("@Mic"));
    },
  );

  it("does not rebind edited, untagged, unknown, disabled or ambiguous names", () => {
    const unavailable: RenderOptions[] = [
      { patch: { edited: true } },
      { patch: { mentions: [] } },
      { participantProfiles: undefined },
      { canOpenLink: undefined },
      { canOpenLink: () => false },
      {
        patch: { mentions: [mic, other] },
        participantProfiles: new Map([
          [mic, { name: "Mic" }],
          [other, { name: "Mic" }],
        ]),
      },
    ];
    for (const options of unavailable) {
      const html = render("**@Mic**", options);
      expect(html).not.toContain("<button");
      expect(html).toContain("<strong>@Mic</strong>");
    }
    const html = render("@Mic Smith and @Mic", {
      patch: { mentions: [smith, mic, other] },
      participantProfiles: new Map([
        [smith, { name: "Mic Smith" }],
        [mic, { name: "Mic" }],
        [other, { name: "Mic Smith" }],
      ]),
    });
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("@Mic Smith and <button");
  });

  it("cannot fabricate profile controls with literal, entity-encoded or legacy markers", () => {
    const spoof =
      "\uE0000\uE0010\uE002 &#57344;&#49;&#57345;0&#57346; \uE000&#x32;\uE0010\uE002 \uE0000\uE001";
    const html = render(`${spoof} then @Mic`);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(
      "\uE0000\uE0010\uE002 \uE0001\uE0010\uE002 \uE0002\uE0010\uE002 \uE0000\uE001 then <button",
    );
    expect(render(spoof)).not.toContain("<button");
    expect(
      render(
        `<span data-inline-text="@Mic" data-profile-target="${profileTarget(mic)}">spoof</span>`,
      ),
    ).not.toContain("<button");
  });
});

describe("Markdown inline extensions", () => {
  it("preserves custom emoji and plugin prose alongside profile mentions", () => {
    const html = render("**:party_parrot:** PLUGIN @Mic", {
      emoji: [party],
      extensions,
      media: () => "https://media.test/emoji.png",
    });
    expect(html).toContain("<strong><img");
    expect(html).toContain('src="https://media.test/emoji.png"');
    expect(html).toContain('alt=":party_parrot:"');
    expect(html).toContain("<mark>PLUGIN</mark>");
    expect(html).toContain('aria-label="View Mic profile"');
  });

  it("keeps links, code, reference labels and image alt text out of inline plugins", () => {
    const html = render(
      "`:party_parrot: PLUGIN @Mic`\n\n```\n:party_parrot: PLUGIN @Mic\n```\n\n[:party_parrot: PLUGIN @Mic](https://example.test)\n\n[:party_parrot: PLUGIN @Mic]\n\n[:party_parrot: PLUGIN @Mic]: https://example.test/ref\n\n![PLUGIN :party_parrot: @Mic](https://example.test/image)",
      {
        emoji: [party],
        extensions,
        media: () => "https://media.test/emoji.png",
      },
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<mark");
    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/[\uE000-\uE002]/);
    expect(html).toContain('href="https://example.test/ref"');
    expect(html).toContain(":party_parrot: PLUGIN @Mic</code>");
    expect(html).toContain("PLUGIN :party_parrot: @Mic</span>");
  });

  it("keeps emoji-only sizing and readable fallback when media or extensions are unavailable", () => {
    const options = { emoji: [party], extensions, largeEmoji: true };
    const html = render(":party_parrot:", {
      ...options,
      media: () => "https://media.test/emoji.png",
    });
    expect(html).toContain(
      `class="${styles.text}" data-single-emoji="true"><img`,
    );
    expect(html).not.toContain("<div");
    expect(render(":party_parrot:", options)).toContain(
      'data-single-emoji="true">:party_parrot:</p>',
    );
    expect(
      render(":party_parrot:", { ...options, extensions: undefined }),
    ).toContain('data-single-emoji="true">:party_parrot:</p>');
    expect(render("😀", { largeEmoji: true })).toContain(
      'data-single-emoji="true">😀</p>',
    );
  });
});

it.each([false, true])(
  "retains formatting inside labeled links (plugin enabled: %s)",
  (enabled) => {
    const links = {
      snapshot: () =>
        enabled
          ? [
              {
                id: "link",
                title: "Links",
                key: "links/link",
                pluginId: "links",
                revision: "one",
                matches: () => true,
                component: ({ url }: { url: string }) => (
                  <LinkLabel href={url} />
                ),
              },
            ]
          : [],
      subscribe: () => () => {},
    };
    const html = render(
      "[**Important** or `code`](https://github.com/block/buzz-app)",
      { extensions: { ...extensions, links } },
    );
    expect(html).toContain("<strong>Important</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://github.com/block/buzz-app"');
    expect(html.includes('data-link-kind="github"')).toBe(enabled);
  },
);

it("keeps resolved channel labels for Buzz autolinks", () => {
  const entry = {
    id: "link",
    title: "Links",
    key: "links/link",
    pluginId: "links",
    revision: "one",
    matches: () => true,
    component: ({ url }: { url: string }) => <LinkLabel href={url} />,
  };
  const href = `buzz://message?channel=design&id=${"a".repeat(64)}`;
  const html = render(`<${href}> <buzz://channel/design>`, {
    directory: {
      profiles: new Map(),
      agents: [],
      channels: [
        {
          id: "design",
          name: "design",
          channelType: "forum",
        },
      ],
    },
    extensions: {
      ...extensions,
      links: { snapshot: () => [entry], subscribe: () => () => {} },
    },
  });
  expect(html).toContain('data-link-kind="message"');
  expect(html).toContain('data-link-kind="channel"');
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).toContain("design");
  expect(text).not.toContain("buzz://");
});
