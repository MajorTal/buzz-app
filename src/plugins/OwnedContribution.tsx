import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  ContributionBoundary,
  contributionKey,
} from "../features/conversation/ContributionBoundary";
// Object identity fences disable/re-enable even when the revision stays "bundled".
export function OwnedContribution<T extends object>({
  entry,
  registry,
  children,
  fallback = (
    <p role="alert">
      This optional control is unavailable. Other settings and channel recovery
      remain available.
    </p>
  ),
}: {
  entry: T;
  registry: { snapshot(): readonly T[] };
  children(entry: T, active: () => boolean): ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <ContributionBoundary key={contributionKey(entry)} fallback={fallback}>
      <Owned key={contributionKey(entry)} entry={entry} registry={registry}>
        {children}
      </Owned>
    </ContributionBoundary>
  );
}
function Owned<T extends object>({
  entry,
  registry,
  children,
}: {
  entry: T;
  registry: { snapshot(): readonly T[] };
  children(entry: T, active: () => boolean): ReactNode;
}) {
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return children(
    entry,
    () => live.current && registry.snapshot().includes(entry),
  );
}
