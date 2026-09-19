import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerAccessory,
  ComposerAccessoryProps,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

export function ComposerAccessories({
  registry,
  ...props
}: ComposerAccessoryProps & {
  registry: ContributionReader<ComposerAccessory>;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const order = (entry: ComposerAccessory) =>
    Number.isFinite(entry.order) ? (entry.order ?? 0) : 0;
  return [...entries]
    .sort(
      (a, b) =>
        order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .map((entry) => (
      <ContributionBoundary
        key={contributionKey(entry)}
        fallback={<p role="status">{entry.title} unavailable</p>}
      >
        <OwnedAccessory entry={entry} registry={registry} {...props} />
      </ContributionBoundary>
    ));
}
function OwnedAccessory({
  entry,
  registry,
  ...props
}: ComposerAccessoryProps & {
  entry: Contribution<ComposerAccessory>;
  registry: ContributionReader<ComposerAccessory>;
}) {
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const [commands, setCommands] =
    useState<Pick<ComposerAccessoryProps, "canOpen" | "open">>();
  useLayoutEffect(() => {
    let live = true;
    const active = () => live && registry.snapshot().includes(entry);
    setCommands({
      canOpen: (target) => active() && current.current.canOpen(target),
      open: (target) => active() && current.current.open(target),
    });
    return () => {
      live = false;
    };
  }, [entry, registry]);
  const Accessory = entry.component;
  return commands ? <Accessory {...props} {...commands} /> : null;
}
