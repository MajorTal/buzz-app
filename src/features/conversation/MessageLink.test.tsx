import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Contribution } from "../../plugins/contributions";
import type { LinkRenderer } from "./contracts";
import { MessageLink, resolveLink } from "./MessageLink";

const entry: Contribution<LinkRenderer> = {
  id: "link",
  title: "Link",
  key: "test/link",
  pluginId: "test",
  revision: "one",
  matches: () => true,
  className: "link-style",
  component: () => <span>Link face</span>,
};
const url = "https://example.com/path?query=yes";
it("keeps anchor destination and host semantics with and without presentation", () => {
  const registry = { snapshot: () => [entry], subscribe: () => () => {} };
  const html = renderToStaticMarkup(
    <MessageLink url={url} registry={registry} onOpenLink={() => true} />,
  );
  expect(html).toContain(`href="${url}"`);
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('class="link-style"');
  expect(html).toContain("Link face");
  const fallback = renderToStaticMarkup(
    <MessageLink url={url} registry={undefined} onOpenLink={() => true} />,
  );
  expect(fallback).toContain(`>${url}</a>`);
  expect(fallback).not.toContain("data-link-renderer");
});
it("skips throwing and unmatched renderers, with first matching presentation winning", () => {
  const broken = {
    ...entry,
    matches() {
      throw new Error("matcher failed");
    },
  };
  const miss = { ...entry, matches: () => false };
  expect(resolveLink(url, [broken, miss, entry, { ...entry }])).toBe(entry);
  expect(resolveLink(url, [broken, miss])).toBeUndefined();
});
