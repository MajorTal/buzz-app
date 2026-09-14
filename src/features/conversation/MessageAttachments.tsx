import { useSyncExternalStore } from "react";
import type {
  ContributionReader,
  MessageAttachment,
  MessageAttachmentProps,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

export function MessageAttachments({
  registry,
  ...props
}: MessageAttachmentProps & {
  registry: ContributionReader<MessageAttachment>;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  return entries.map((entry) => {
    try {
      if (!entry.matches(props.message)) return null;
    } catch {
      return null;
    }
    const Render = entry.component;
    return (
      <ContributionBoundary
        key={`${props.scope}:${props.message.id}:${contributionKey(entry)}`}
        fallback={<small>Could not display {entry.title}.</small>}
      >
        <Render {...props} />
      </ContributionBoundary>
    );
  });
}
