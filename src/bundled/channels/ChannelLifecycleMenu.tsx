import { useEffect, useState } from "react";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import type {
  ChannelLifecycleAction,
  ChannelLifecycleSettings,
} from "../../features/relay/channel-lifecycle-protocol";

/** Mounted only while a menu is open: no per-row/background capability reads. */
export function ChannelLifecycleMenu({
  channelId,
  lifecycle,
  choose,
  disabled,
}: {
  channelId: string;
  lifecycle: ChannelLifecycleCapability;
  choose(action: ChannelLifecycleAction): void;
  disabled: boolean;
}) {
  const [state, setState] = useState<ChannelLifecycleSettings>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry starts a fresh permission lookup.
  useEffect(() => {
    if (!lifecycle.available) return;
    const controller = new AbortController();
    setState(undefined);
    setError("");
    void lifecycle.load(channelId, controller.signal).then(
      (settings) => {
        if (!controller.signal.aborted) setState(settings);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => controller.abort();
  }, [channelId, lifecycle, retry]);
  if (!lifecycle.available)
    return (
      <MenuItem disabled>
        Channel actions unavailable on this connection
      </MenuItem>
    );
  if (error)
    return (
      <>
        <p role="alert">{error}</p>
        <MenuItem
          closeOnClick={false}
          disabled={disabled}
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry channel permissions
        </MenuItem>
      </>
    );
  if (!state)
    return <MenuItem disabled>Checking channel permissions…</MenuItem>;
  return (
    <>
      {state.canHide ? (
        <MenuItem disabled={disabled} onClick={() => choose("hide")}>
          Hide conversation…
        </MenuItem>
      ) : (
        <>
          {state.canArchive && (
            <MenuItem disabled={disabled} onClick={() => choose("archive")}>
              Archive channel…
            </MenuItem>
          )}
          {state.canDelete && (
            <MenuItem disabled={disabled} onClick={() => choose("delete")}>
              Delete channel…
            </MenuItem>
          )}
          <MenuItem
            disabled={disabled || !state.canLeave}
            onClick={() => choose("leave")}
          >
            Leave channel…
          </MenuItem>
          {state.leaveReason && <p>{state.leaveReason}</p>}
        </>
      )}
    </>
  );
}
