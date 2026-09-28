import {
  Children,
  isValidElement,
  memo,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { PhrasingContent, Root, RootContent } from "mdast";
import { MediaAttachment } from "../../features/messages/MediaAttachment";
import { AudioAttachment } from "../../features/messages/AudioAttachment";
import {
  MAX_MARKDOWN_LENGTH,
  MAX_MARKDOWN_DEPTH,
  scanMarkdown,
} from "../../features/relay/message-content";
import {
  attachmentFor,
  attachmentMetadata,
  bodyUrl,
  inertHtml,
} from "./attachments";
import styles from "./GitHub.module.css";

function containsImage(node: NonNullable<ExtraProps["node"]>): boolean {
  return (
    node.tagName === "img" ||
    node.children.some(
      (child) => child.type === "element" && containsImage(child),
    )
  );
}

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      return isValidElement<{ children?: ReactNode }>(child)
        ? plainText(child.props.children)
        : "";
    })
    .join("");
}

// Extract content into Markdown nodes; HTML elements and attributes stay inert.
function htmlContent(html: string): PhrasingContent[] {
  const convert = (node: ChildNode, depth: number): PhrasingContent[] => {
    if (node.nodeType === Node.TEXT_NODE)
      return [{ type: "text", value: node.textContent ?? "" }];
    if (!(node instanceof Element)) return [];
    if (depth > MAX_MARKDOWN_DEPTH)
      return [{ type: "text", value: node.outerHTML }];
    if (node.localName === "img")
      return [
        {
          type: "image",
          url: node.getAttribute("src") ?? "",
          alt: node.getAttribute("alt") ?? "",
        },
      ];

    const children = [...node.childNodes].flatMap((child) =>
      convert(child, depth + 1),
    );
    const destination = node.getAttribute(
      node.localName === "a" ? "href" : "src",
    );
    if (
      destination &&
      ["a", "video", "audio", "source"].includes(node.localName)
    ) {
      const label = [{ type: "text" as const, value: destination }];
      if (
        node.localName === "a" &&
        !children.some((child) => child.type === "link")
      )
        return [
          {
            type: "link",
            url: destination,
            children: children.length ? children : label,
          },
        ];
      return [{ type: "link", url: destination, children: label }, ...children];
    }
    if (["br", "hr"].includes(node.localName)) return [{ type: "break" }];
    // Adjacent table cells need a separator; rows already break below.
    if (["td", "th"].includes(node.localName))
      return [...children, { type: "text", value: " " }];
    if (
      [
        "details",
        "summary",
        "div",
        "p",
        "blockquote",
        "li",
        "tr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
      ].includes(node.localName)
    )
      return [{ type: "break" }, ...children, { type: "break" }];
    return children;
  };
  return [...inertHtml(html).childNodes].flatMap((node) => convert(node, 0));
}

// A lone opening anchor tag yields its destination; anything else does not.
function anchorHref(html: string): string | null {
  if (!/^<a(\s[^<>]*)?>$/i.test(html.trim())) return null;
  return inertHtml(html).querySelector("a")?.getAttribute("href") ?? null;
}

function githubHtml() {
  return (tree: Root) => {
    const visit = (parent: { type: string; children: RootContent[] }) => {
      const block = ["root", "blockquote", "listItem"].includes(parent.type);
      const result: RootContent[] = [];
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index];
        if (!node) continue;
        if (node.type !== "html") {
          if ("children" in node) visit(node);
          result.push(node);
          continue;
        }
        // micromark splits an inline HTML anchor into opening-tag, label and
        // closing-tag siblings; rejoin the pair so the label stays linked.
        const href = anchorHref(node.value);
        const closing =
          href === null
            ? -1
            : parent.children.findIndex(
                (sibling, at) =>
                  at > index &&
                  sibling.type === "html" &&
                  /^<\/a\s*>$/i.test(sibling.value.trim()),
              );
        let content: PhrasingContent[];
        if (href !== null && closing !== -1) {
          const label = {
            type: "paragraph",
            children: parent.children.slice(index + 1, closing),
          };
          visit(label);
          content = [
            {
              type: "link",
              url: href,
              children: label.children as PhrasingContent[],
            },
          ];
          index = closing;
        } else {
          content = htmlContent(node.value);
        }
        if (block) result.push({ type: "paragraph", children: content });
        else result.push(...content);
      }
      parent.children = result;
    };
    visit(tree);
  };
}

function EmbeddedAttachment({
  children,
  fallback,
  caption,
}: {
  children: ReactNode;
  fallback: ReactNode;
  caption: ReactNode;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className={styles.attachment}
      onLoadCapture={() => setLoaded(true)}
      onLoadedDataCapture={() => setLoaded(true)}
      onErrorCapture={() => setLoaded(false)}
    >
      {children}
      {loaded ? caption : fallback}
    </div>
  );
}

export const GitHubBody = memo(function GitHubBody({
  body,
  bodyHtml,
  url,
}: {
  body: string;
  bodyHtml?: string | undefined;
  url: string;
}) {
  const bounded = useMemo(
    () => body.length <= MAX_MARKDOWN_LENGTH && !scanMarkdown(body).tooDeep,
    [body],
  );
  const metadata = useMemo(
    () => (bounded ? attachmentMetadata(bodyHtml) : new Map()),
    [bounded, bodyHtml],
  );
  if (!bounded) return <div className={styles.plainBody}>{body}</div>;

  const media = (
    source: string,
    label: ReactNode,
    image = false,
    description?: string,
  ) => {
    const attachment = attachmentFor(source, metadata, image);
    const link = (
      <a href={source} target="_blank" rel="noreferrer">
        {label || attachment?.name || "Open attachment"}
      </a>
    );
    if (!attachment) return link;
    return (
      <EmbeddedAttachment
        key={source}
        fallback={link}
        caption={
          !image && Children.toArray(label).some((part) => part !== source)
            ? label
            : null
        }
      >
        {attachment.kind === "audio" ? (
          <AudioAttachment attachment={attachment} source={source} />
        ) : (
          <MediaAttachment
            attachment={attachment}
            media={(value) => value}
            {...(description !== undefined
              ? { imageDescription: description }
              : {})}
            preload="metadata"
          />
        )}
      </EmbeddedAttachment>
    );
  };

  return (
    <div className={styles.body}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks, githubHtml]}
        urlTransform={(value) => bodyUrl(value, url) ?? ""}
        components={{
          // Players are block elements, including when embedded in prose.
          p: ({ children }) => (
            <div className={styles.paragraph}>{children}</div>
          ),
          a: ({ href, children, node }) => {
            if (!href) return <>{children}</>;
            if (node && containsImage(node))
              return (
                <div>
                  {children}
                  <a href={href} target="_blank" rel="noreferrer">
                    {href}
                  </a>
                </div>
              );
            return media(
              href,
              children,
              false,
              plainText(children) || undefined,
            );
          },
          img: ({ src, alt }) =>
            typeof src === "string" && src ? media(src, alt, true, alt) : alt,
          table: ({ children }) => (
            <div className={styles.tableScroll}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {body}
      </Markdown>
    </div>
  );
});
