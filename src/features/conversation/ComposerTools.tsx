import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerTool,
  ComposerToolProps,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

export function ComposerTools({
  registry,
  renderLeading,
  ...props
}: ComposerToolProps & {
  registry: ContributionReader<ComposerTool>;
  /** Host layout for tools ordered before the default group; preserves DOM order. */
  renderLeading?: (tools: ReactNode) => ReactNode;
}) {
  const tools = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  // Activation/re-enable order must not shuffle the visual or keyboard order.
  const order = (tool: ComposerTool) =>
    Number.isFinite(tool.order) ? (tool.order ?? 0) : 0;
  const sorted = [...tools].sort(
    (a, b) =>
      order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const render = (tool: Contribution<ComposerTool>) => (
    <ContributionBoundary
      key={contributionKey(tool)}
      fallback={<span role="status">{tool.title} unavailable</span>}
    >
      <OwnedTool tool={tool} registry={registry} {...props} />
    </ContributionBoundary>
  );
  if (!renderLeading) return sorted.map(render);
  return (
    <>
      {renderLeading(sorted.filter((tool) => order(tool) < 0).map(render))}
      {sorted.filter((tool) => order(tool) >= 0).map(render)}
    </>
  );
}
function OwnedTool({
  tool,
  registry,
  ...props
}: ComposerToolProps & {
  tool: Contribution<ComposerTool>;
  registry: ContributionReader<ComposerTool>;
}) {
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const [commands, setCommands] =
    useState<
      Pick<
        ComposerToolProps,
        "insertText" | "insertMention" | "insertResource" | "focus"
      >
    >();
  useLayoutEffect(() => {
    let live = true;
    const active = () =>
      live && registry.snapshot().includes(tool) && !current.current.disabled;
    setCommands({
      insertText: (text) =>
        active() ? current.current.insertText(text) : false,
      insertMention: (recipient) =>
        active() ? current.current.insertMention(recipient) : false,
      insertResource: (resource) =>
        active()
          ? current.current.insertResource(resource)
          : "The message can't be edited right now",
      focus: () => {
        if (active()) current.current.focus();
      },
    });
    return () => {
      live = false;
    };
  }, [tool, registry]);
  const Tool = tool.component;
  return commands ? <Tool {...props} {...commands} /> : null;
}
