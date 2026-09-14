import { useSyncExternalStore, type ReactNode } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ContributionReader,
  InlineContent,
  InlineRange,
  InlineRenderer,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

type Match = InlineRange & { renderer: Contribution<InlineRenderer> };
/** First registered renderer wins overlapping ranges; malformed/throwing matchers are skipped. */
export function inlineMatches(
  content: InlineContent,
  renderers: readonly Contribution<InlineRenderer>[],
): Match[] {
  const matches: Match[] = [];
  for (const renderer of renderers) {
    if (content.link && !renderer.links) continue;
    try {
      const ranges = renderer.matches(content);
      if (!Array.isArray(ranges) || ranges.length > content.text.length)
        continue;
      for (const range of ranges) {
        if (
          !range ||
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          range.start < 0 ||
          range.end <= range.start ||
          range.end > content.text.length ||
          (content.link &&
            (range.start !== 0 || range.end !== content.text.length)) ||
          matches.some((m) => range.start < m.end && range.end > m.start)
        )
          continue;
        matches.push({ start: range.start, end: range.end, renderer });
      }
    } catch {
      /* A broken optional renderer leaves readable text. */
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}
export function InlineText({
  registry,
  content,
  media,
  fallback,
}: {
  registry: ContributionReader<InlineRenderer>;
  content: InlineContent;
  media(url: string): string | undefined;
  fallback?: ReactNode;
}) {
  const renderers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const nodes = [];
  let offset = 0;
  const matches = inlineMatches(content, renderers);
  if (content.link && !matches.length) return <>{fallback ?? content.text}</>;
  for (const match of matches) {
    nodes.push(content.text.slice(offset, match.start));
    const text = content.text.slice(match.start, match.end);
    const Render = match.renderer.component;
    nodes.push(
      <ContributionBoundary
        key={`${contributionKey(match.renderer)}:${match.start}:${text}`}
        fallback={content.link ? (fallback ?? text) : text}
      >
        <Render
          text={text}
          content={content}
          media={media}
          fallback={fallback}
        />
      </ContributionBoundary>,
    );
    offset = match.end;
  }
  nodes.push(content.text.slice(offset));
  return <>{nodes}</>;
}
