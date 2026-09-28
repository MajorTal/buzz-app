import { useEffect, useState } from "react";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import { Button } from "../../shared/design-system/ui/Button";
import { SignOutIcon } from "../../shared/design-system/icons";

/** Settings reads permissions only while open; the sidebar owns confirmation. */
export function ChannelLeaveButton({
  channelId,
  lifecycle,
  choose,
}: {
  channelId: string;
  lifecycle: ChannelLifecycleCapability;
  choose(trigger: HTMLElement): void;
}) {
  const [state, setState] = useState<{
    channelId: string;
    lifecycle: ChannelLifecycleCapability;
    canLeave?: boolean;
    failed?: boolean;
  }>();
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry starts a fresh permission lookup.
  useEffect(() => {
    if (!lifecycle.available) return;
    const controller = new AbortController();
    setState(undefined);
    void lifecycle.load(channelId, controller.signal).then(
      ({ canLeave }) => {
        if (!controller.signal.aborted)
          setState({ channelId, lifecycle, canLeave });
      },
      () => {
        if (!controller.signal.aborted)
          setState({ channelId, lifecycle, failed: true });
      },
    );
    return () => controller.abort();
  }, [channelId, lifecycle, retry]);
  if (!lifecycle.available)
    return <p>Channel actions unavailable on this connection</p>;
  if (state?.channelId !== channelId || state.lifecycle !== lifecycle)
    return null;
  if (state.failed)
    return (
      <div>
        <p role="alert">Channel actions unavailable</p>
        <Button onClick={() => setRetry((value) => value + 1)}>
          Retry channel permissions
        </Button>
      </div>
    );
  if (!state.canLeave) return null;
  return (
    <Button
      variant="destructive"
      onClick={(event) => choose(event.currentTarget)}
    >
      <SignOutIcon size={16} aria-hidden="true" />
      Leave channel
    </Button>
  );
}
