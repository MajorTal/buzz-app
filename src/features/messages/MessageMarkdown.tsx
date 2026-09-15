import {
  Children,
  createContext,
  isValidElement,
  useContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import { MessageLink } from "../conversation/MessageLink";
import { parseBuzzLink } from "../navigation/buzz-links";
import { messageLinkParts, normalizeWrappedLinks } from "./message-link-parts";
import {
  ReferenceText,
  channelLinkLabel,
  emptyReferenceDirectory,
} from "./ReferenceText";
import { IconAt, IconRobot } from "@tabler/icons-react";
import { profileKey } from "../profiles/target";
import referenceStyles from "../../shared/InlineReference.module.css";
import Markdown, {
  type Components,
  type ExtraProps,
  type UrlTransform,
} from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { ConversationExtensions } from "../conversation/contracts";
import { InlineText } from "../conversation/InlineText";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { emojiMatches, messageParts } from "../relay/emoji";
import {
  MAX_MARKDOWN_LENGTH,
  scanMarkdown,
  safeMessageUrl,
} from "../relay/message-content";
import styles from "./Messages.module.css";
import { profileMentionParts } from "./profile-mentions";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string;
  alt?: string;
  identifier?: string;
  label?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
};

type InlinePart = { text: string; target?: string | undefined };
type ProtectedContent = {
  content: string;
  prefix: string;
  parts: InlinePart[];
};
const literalContext = (type: string) =>
  [
    "code",
    "inlineCode",
    "link",
    "linkReference",
    "image",
    "imageReference",
    "definition",
    "html",
  ].includes(type);

/** Bind exact names on the FULL signed body, before Markdown decodes escapes or
 * divides emphasis. Reference labels must also survive unchanged for resolution. */
function protectInlineContent(
  row: ChannelMessage,
  profiles: ReadonlyMap<string, Profile> | undefined,
  tree: MarkdownNode,
  agents: typeof emptyReferenceDirectory.agents,
): ProtectedContent {
  const literalRanges: { start: number; end: number }[] = [];
  const visit = (node: MarkdownNode) => {
    if (literalContext(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        literalRanges.push({ start, end });
    } else {
      for (const child of node.children ?? []) visit(child);
    }
  };
  visit(tree);
  let rangeIndex = 0;
  const isLiteral = (start: number, end: number) => {
    while (
      literalRanges[rangeIndex] &&
      (literalRanges[rangeIndex]?.end ?? 0) <= start
    )
      rangeIndex++;
    return (literalRanges[rangeIndex]?.start ?? Infinity) < end;
  };

  // Numeric entities can manufacture private-use characters during parsing too.
  // Choose an unused prefix in that decoded source; never trust a fixed marker.
  const decoded = row.content.replace(
    /&#(x[a-f\d]{1,6}|\d{1,7});/gi,
    (entity, number: string) => {
      const code =
        number[0]?.toLowerCase() === "x"
          ? Number.parseInt(number.slice(1), 16)
          : Number.parseInt(number, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
  const used = new Set(
    [...decoded.matchAll(/\uE000(\d+)\uE001/g)].map((match) => match[1]),
  );
  let nonce = 0;
  while (used.has(String(nonce))) nonce++;
  const prefix = `\uE000${nonce}\uE001`;
  const parts: InlinePart[] = [];
  const token = (part: InlinePart) => {
    parts.push(part);
    return `${prefix}${parts.length - 1}\uE002`;
  };
  let offset = 0;
  const content = profileMentionParts(row, profiles, agents)
    .map((segment) => {
      const start = offset;
      offset += segment.text.length;
      if (segment.target && !isLiteral(start, offset)) return token(segment);
      let partOffset = start;
      return messageParts(segment.text)
        .map((part) => {
          const partStart = partOffset;
          partOffset += part.length;
          if (part.startsWith("https://")) return part;
          let result = "";
          let end = 0;
          for (const match of emojiMatches(part, row.emoji ?? [])) {
            if (isLiteral(partStart + match.start, partStart + match.end))
              continue;
            result += part.slice(end, match.start);
            result += token({ text: part.slice(match.start, match.end) });
            end = match.end;
          }
          return result + part.slice(end);
        })
        .join("");
    })
    .join("");
  return { content, prefix, parts };
}

const placeholderPattern = (protectedContent: ProtectedContent) =>
  new RegExp(`${protectedContent.prefix}(\\d+)\uE002`, "g");

/** Offer only Markdown prose to profile controls and inline plugins. */
function remarkInlineContent(protectedContent: ProtectedContent) {
  const restore = (value: string) =>
    value.replace(
      placeholderPattern(protectedContent),
      (match, index: string) =>
        protectedContent.parts[Number(index)]?.text ?? match,
    );
  const restoreLiteral = (node: MarkdownNode) => {
    for (const key of [
      "value",
      "url",
      "title",
      "alt",
      "identifier",
      "label",
    ] as const) {
      const value = node[key];
      if (typeof value === "string") node[key] = restore(value);
    }
    for (const child of node.children ?? []) restoreLiteral(child);
  };
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (literalContext(parent.type)) {
        restoreLiteral(parent);
        return;
      }
      if (!parent.children) return;
      parent.children = parent.children.flatMap((child) => {
        if (child.type !== "text" || typeof child.value !== "string") {
          visit(child);
          return [child];
        }
        const parts: InlinePart[] = [];
        let plain = "";
        let end = 0;
        for (const match of child.value.matchAll(
          placeholderPattern(protectedContent),
        )) {
          plain += child.value.slice(end, match.index);
          const part = protectedContent.parts[Number(match[1])];
          if (part?.target) {
            if (plain) parts.push({ text: plain });
            parts.push(part);
            plain = "";
          } else {
            plain += part?.text ?? match[0];
          }
          end = match.index + match[0].length;
        }
        plain += child.value.slice(end);
        if (plain) parts.push({ text: plain });
        return parts.map((part) => ({
          type: "buzzInlineContent",
          data: {
            hName: "span",
            hProperties: {
              "data-inline-text": part.text,
              ...(part.target ? { "data-profile-target": part.target } : {}),
            },
          },
        }));
      });
    };
    visit(tree);
  };
}

const transformUrl: UrlTransform = (value) =>
  parseBuzzLink(value) ? value : safeMessageUrl(value);
const labelText = (children: ReactNode): string =>
  Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? labelText(child.props.children)
        : String(child),
    )
    .join("");

type MessageComponents = {
  [Tag in "p" | "a" | "img" | "span"]: (
    props: ComponentPropsWithoutRef<Tag> & ExtraProps,
  ) => ReactNode;
};
const MessageComponentsContext = createContext<MessageComponents | null>(null);
function useMessageComponents() {
  const components = useContext(MessageComponentsContext);
  if (!components) throw new Error("Missing message rendering context");
  return components;
}
// Keep component types stable: profile/directory updates must not remount a
// focused link or discard its pending preview timer.
const markdownComponents: Components = {
  p: (props) => useMessageComponents().p(props),
  a: (props) => useMessageComponents().a(props),
  img: (props) => useMessageComponents().img(props),
  span: (props) => useMessageComponents().span(props),
};

export function MessageMarkdown({
  row,
  directory = emptyReferenceDirectory,
  session,
  scope,
  extensions,
  media,
  onOpenLink,
  canOpenLink,
  participantProfiles,
  largeEmoji = false,
  interactive = true,
}: {
  row: ChannelMessage;
  directory?: typeof emptyReferenceDirectory;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  extensions?: ConversationExtensions | undefined;
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
  largeEmoji?: boolean | undefined;
  interactive?: boolean;
}) {
  if (row.content.length > MAX_MARKDOWN_LENGTH)
    return <div className={styles.plainText}>{row.content}</div>;
  let scan = scanMarkdown(row.content);
  if (scan.tooDeep)
    return <div className={styles.plainText}>{row.content}</div>;

  const literalRanges: { start: number; end: number }[] = [];
  const collectLiterals = (node: MarkdownNode) => {
    if (literalContext(node.type) && node.type !== "link") {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        literalRanges.push({ start, end });
    } else for (const child of node.children ?? []) collectLiterals(child);
  };
  collectLiterals(scan.tree);
  const normalized = normalizeWrappedLinks(row.content, (start, end) =>
    literalRanges.some((range) => start < range.end && end > range.start),
  );
  if (normalized !== row.content) {
    row = { ...row, content: normalized };
    scan = scanMarkdown(normalized);
  }
  const renderLink = (url: string, label?: string, children?: ReactNode) => (
    <MessageLink
      url={url}
      label={label ?? channelLinkLabel(url, scope, directory.channels)}
      registry={extensions?.links}
      onOpenLink={onOpenLink}
      session={session}
      scope={scope}
      interactive={interactive}
    >
      {children}
    </MessageLink>
  );
  const renderInline = (text: string) =>
    extensions ? (
      <InlineText
        registry={extensions.inline}
        content={{ text, message: row }}
        media={media}
      />
    ) : (
      text
    );
  const renderText = (text: string) => {
    let offset = 0;
    return messageLinkParts(text).map((part) => {
      const key = `${offset}:${part.text}`;
      offset += part.text.length;
      return part.url ? (
        <span key={key}>{renderLink(part.url, part.label)}</span>
      ) : (
        <ReferenceText
          key={key}
          text={part.text}
          mentions={[]}
          directory={directory}
          renderText={renderInline}
          onOpenLink={onOpenLink}
          extensions={extensions}
          session={session}
          scope={scope}
          interactive={interactive}
        />
      );
    });
  };

  const protectedContent = protectInlineContent(
    row,
    participantProfiles ?? directory.profiles,
    scan.tree,
    directory.agents,
  );
  const components: MessageComponents = {
    p: ({ node: _node, ...props }) => (
      <p
        {...props}
        className={largeEmoji ? styles.text : undefined}
        data-single-emoji={largeEmoji || undefined}
      />
    ),
    a: ({ href, children }) =>
      href ? (
        renderLink(
          href,
          labelText(children) === href ? undefined : labelText(children),
          labelText(children) === href ? undefined : children,
        )
      ) : (
        <span>{children}</span>
      ),
    img: ({ node: _node, alt }) =>
      alt ? <span className={styles.imageAlt}>{alt}</span> : null,
    span: ({ node: _node, children, ...props }) => {
      const { "data-inline-text": text, "data-profile-target": target } =
        props as typeof props & {
          "data-inline-text"?: unknown;
          "data-profile-target"?: unknown;
        };
      const key = typeof target === "string" ? profileKey(target) : undefined;
      const agent =
        !!key &&
        (directory.agents.some((agent) => agent.pubkey === key) ||
          (participantProfiles ?? directory.profiles).get(key)?.isAgent);
      const clickable =
        interactive && typeof target === "string" && !!canOpenLink?.(target);
      if (
        typeof text === "string" &&
        typeof target === "string" &&
        (!interactive || clickable || agent)
      ) {
        const Icon = agent ? IconRobot : IconAt;
        const Mention = clickable ? "button" : "span";
        return (
          <Mention
            type={clickable ? "button" : undefined}
            className={referenceStyles.link}
            data-mention-kind={agent ? "agent" : "person"}
            aria-label={clickable ? `View ${text.slice(1)} profile` : undefined}
            onClick={
              clickable
                ? (event) => {
                    event.currentTarget.focus();
                    onOpenLink(target);
                  }
                : undefined
            }
          >
            <Icon aria-hidden="true" className={referenceStyles.icon} />
            {text.slice(1)}
          </Mention>
        );
      }
      return typeof text === "string" ? (
        renderText(text)
      ) : (
        <span {...props}>{children}</span>
      );
    },
  };

  const markdown = (
    <MessageComponentsContext value={components}>
      <Markdown
        remarkPlugins={[
          remarkGfm,
          remarkBreaks,
          [remarkInlineContent, protectedContent],
        ]}
        components={markdownComponents}
        skipHtml
        urlTransform={transformUrl}
      >
        {protectedContent.content}
      </Markdown>
    </MessageComponentsContext>
  );
  return largeEmoji ? markdown : <div className={styles.text}>{markdown}</div>;
}
