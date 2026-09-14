import { Button } from "../../shared/design-system/ui/Button";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { EventData } from "../relay/events";
import type { ComposerTool, ContributionReader } from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { messageViewKey } from "../messages/view-key";
import type { Outbox } from "../relay/outbox";

const toolOrder = (tool: ComposerTool) =>
  Number.isFinite(tool.order) ? (tool.order ?? 0) : 0;
export function selectReactionTool(
  tools: readonly Contribution<ComposerTool>[],
) {
  return tools
    .filter((tool) => tool.reactionComponent)
    .sort(
      (a, b) =>
        toolOrder(a) - toolOrder(b) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )[0];
}

export function ReactionTool({
  registry,
  ...props
}: {
  registry: ContributionReader<ComposerTool>;
  session: RelaySession;
  scope: string;
  messageId: string;
  disabled: boolean;
}) {
  const tools = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const tool = selectReactionTool(tools);
  return tool ? (
    <ContributionBoundary
      key={contributionKey(tool)}
      fallback={<span role="status">Reactions unavailable</span>}
    >
      <OwnedReactionTool
        key={messageViewKey(props.session, props.scope, props.messageId)}
        registry={registry}
        tool={tool}
        {...props}
      />
    </ContributionBoundary>
  ) : null;
}

function OwnedReactionTool({
  registry,
  tool,
  session,
  scope,
  messageId,
  disabled,
}: {
  registry: ContributionReader<ComposerTool>;
  tool: Contribution<ComposerTool>;
  session: RelaySession;
  scope: string;
  messageId: string;
  disabled: boolean;
}) {
  const [error, setError] = useState<string>();
  const alive = useRef(false);
  const unavailable = useRef(disabled);
  useLayoutEffect(() => {
    unavailable.current = disabled;
  });
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const Picker = tool.reactionComponent;
  return Picker ? (
    <>
      <Picker
        session={session}
        scope={scope}
        disabled={disabled}
        select={(emoji) => {
          if (
            !alive.current ||
            unavailable.current ||
            !registry.snapshot().includes(tool)
          )
            return false;
          try {
            session.messages.react(messageId, emoji);
            setError(undefined);
            return true;
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not add reaction. Try again.",
            );
            return false;
          }
        }}
      />
      {error && <span role="alert">{error}</span>}
      {session.outbox && (
        <ReactionDelivery outbox={session.outbox} messageId={messageId} />
      )}
    </>
  ) : null;
}

export function reactionTarget(event: Pick<EventData, "kind" | "tags">) {
  return event.kind === 7
    ? event.tags.find((tag) => tag[0] === "e")?.[1]
    : undefined;
}

function ReactionDelivery({
  outbox,
  messageId,
}: {
  outbox: Outbox;
  messageId: string;
}) {
  const operations = useSyncExternalStore(
    outbox.subscribe,
    outbox.snapshot,
    outbox.snapshot,
  );
  const operation = operations.find(
    (item) =>
      ["failed", "unknown"].includes(item.delivery) &&
      reactionTarget(item.event) === messageId,
  );
  if (!operation) return null;
  return (
    <span role="status">
      {operation.delivery === "failed"
        ? "Couldn’t add reaction."
        : "Reaction delivery not confirmed."}{" "}
      <Button
        variant="ghost"
        size="compact"
        onClick={() => outbox.retry(operation.event.id)}
      >
        Retry reaction
      </Button>
    </span>
  );
}
