import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { targetLink } from "../../features/navigation/targets";
import { InlineLink, LinkLabel, linkKind } from "./InlineLink";
import {
  LinkLabelContext,
  LinkContentContext,
} from "../../features/conversation/LinkLabelContext";

it("identifies exact GitHub hosts, ordinary websites, and valid Buzz locators", () => {
  expect(linkKind("https://github.com/block/buzz")).toBe("github");
  expect(linkKind("https://github.com.example.com/block/buzz")).toBe("web");
  expect(linkKind("https://example.com/github.com")).toBe("web");
  expect(linkKind(targetLink({ version: 1, kind: "home" }))).toBe("buzz");
  expect(
    linkKind(
      targetLink({
        version: 1,
        kind: "conversation",
        scope: {
          viewer: "1".repeat(64),
          communityOrigin: "https://example.com",
        },
        channelId: "general",
        messageId: "2".repeat(64),
        threadRootId: "2".repeat(64),
      }),
    ),
  ).toBe("thread");
});

it.each([
  ["buzz://channel/general", "channel", "Channel"],
  [`buzz://message?channel=general&id=${"a".repeat(64)}`, "message", "Message"],
  [
    `buzz://message?channel=general&id=${"a".repeat(64)}&thread=${"b".repeat(64)}`,
    "thread",
    "Thread",
  ],
])("renders semantic Buzz labels for %s", (href, kind, label) => {
  const html = renderToStaticMarkup(<InlineLink href={href} />);
  expect(html).toContain(`data-link-kind="${kind}"`);
  expect(html.replace(/<[^>]+>/g, "")).toBe(label);
  expect(html).toContain('href="buzz://');
});

it.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "buzz://unknown",
  "not a URL",
])("leaves unsupported destinations as plain text: %s", (href) => {
  expect(
    renderToStaticMarkup(<InlineLink href={href}>Reference</InlineLink>),
  ).toBe("Reference");
});

it("preserves the destination and readable full label", () => {
  const href = "https://github.com/block/buzz/issues/1234";
  const markup = renderToStaticMarkup(
    <InlineLink href={href} target="_blank" rel="noreferrer" />,
  );
  expect(markup).toContain(`href="${href}"`);
  expect(markup).toContain('data-kind="github"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup.replace(/<[^>]+>/g, "")).toBe(href);
});

it.each([
  ["https://drive.google.com/drive/folders/example", "drive"],
  ["https://docs.google.com/document/d/example/edit", "document"],
  ["https://docs.google.com/spreadsheets/d/example/edit", "spreadsheet"],
  ["https://docs.google.com/presentation/d/example/edit", "presentation"],
  ["https://docs.google.com/forms/d/example/edit", "drive"],
])("recognizes Google Drive file types: %s", (url, kind) => {
  expect(linkKind(url)).toBe(kind);
});

it.each([
  ["https://www.figma.com/design/example", "figma"],
  ["https://www.notion.so/example", "notion"],
  ["https://team.notion.site/example", "notion"],
  ["https://workspace.slack.com/archives/example", "slack"],
  ["https://app.slack.com/client/example", "slack"],
  ["https://www.dropbox.com/scl/fi/example", "dropbox"],
  ["https://db.tt/example", "dropbox"],
  ["https://onedrive.live.com/?id=example", "onedrive"],
  ["https://1drv.ms/w/example", "onedrive"],
  ["https://example-my.sharepoint.com/personal/example", "onedrive"],
  ["https://example.sharepoint.com/sites/example", "web"],
  ["https://example-my.sharepoint.com.evil.test/personal/example", "web"],
  ["https://gitlab.com/example/project", "gitlab"],
  ["https://www.youtube.com/watch?v=example", "youtube"],
  ["https://youtu.be/example", "youtube"],
  ["https://www.loom.com/share/example", "loom"],
  ["https://us02web.zoom.us/j/example", "zoom"],
  ["https://zoom.com/j/example", "zoom"],
  ["https://teams.microsoft.com/l/meetup-join/example", "teams"],
  ["https://teams.live.com/meet/example", "teams"],
  ["https://teams.cloud.microsoft/l/meetup-join/example", "teams"],
])("renders the service icon for %s", (href, kind) => {
  expect(linkKind(href)).toBe(kind);
  const markup = renderToStaticMarkup(<InlineLink href={href} />);
  expect(markup).toContain(`data-link-kind="${kind}"`);
  expect(markup).toContain(`href="${href}"`);
});

it.each([44, 45, 46, 200])(
  "caps raw URL labels at 45 characters (source length %i)",
  (length) => {
    const href = "https://figma.com/design/".padEnd(length, "a");
    const markup = renderToStaticMarkup(<InlineLink href={href} />);
    const text = markup.replace(/<[^>]+>/g, "");
    expect(markup).toContain(`href="${href}"`);
    expect(text).toBe(length <= 45 ? href : `${href.slice(0, 44)}…`);
  },
);

it("preserves authored labels on long URLs", () => {
  const href = `https://figma.com/design/${"a".repeat(100)}`;
  const label = "View the full design and all of the discussion notes";
  const markup = renderToStaticMarkup(
    <InlineLink href={href}>{label}</InlineLink>,
  );
  expect(markup.replace(/<[^>]+>/g, "")).toBe(label);
  expect(markup).toContain(`href="${href}"`);
});

it("truncates a Unicode URL when Markdown encodes its destination", () => {
  const label =
    "https://www.figma.com/design/example/Builderlab-—-Branding?node-id=1119-21207";
  const href = new URL(label).href;
  const markup = renderToStaticMarkup(
    <LinkLabelContext value={label}>
      <LinkContentContext value={[label]}>
        <LinkLabel href={href} />
      </LinkContentContext>
    </LinkLabelContext>,
  );
  expect(markup.replace(/<[^>]+>/g, "")).toBe(`${label.slice(0, 44)}…`);
});

it.each([
  "figma.com",
  "notion.so",
  "slack.com",
  "dropbox.com",
  "onedrive.live.com",
  "gitlab.com",
  "youtube.com",
  "loom.com",
  "zoom.us",
  "teams.microsoft.com",
])("does not brand lookalike destinations for %s", (host) => {
  expect(linkKind(`https://${host}.example.com/file`)).toBe("web");
  expect(linkKind(`https://fake${host}/file`)).toBe("web");
  expect(linkKind(`https://example.com/${host}`)).toBe("web");
  expect(linkKind(`https://${host}@example.com/file`)).toBe("web");
});
it("does not mistake lookalike hosts or URL paths for Google Drive", () => {
  expect(linkKind("https://drive.google.com.example.com/file")).toBe("web");
  expect(linkKind("https://example.com/drive.google.com")).toBe("web");
});
