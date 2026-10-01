import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLifecycleCapability,
} from "../../features/relay/channel-lifecycle";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { Dialog } from "../../shared/design-system/ui/Dialog";

const copy = {
  archive: {
    title: "Archive channel",
    detail:
      "Archive this channel for everyone and remove it from the sidebar. Messages are kept. Find it in search and open Settings to unarchive it later.",
  },
  unarchive: {
    title: "Unarchive channel",
    detail:
      "Unarchive this channel for everyone and return it to the sidebar. Members can send messages again.",
  },
  delete: {
    title: "Delete channel",
    detail:
      "Delete this channel for everyone. You cannot undo this action from Buzz.",
  },
  leave: {
    title: "Leave channel",
    detail:
      "Leave this channel and remove it from your sidebar. You may need an invitation to rejoin a private channel.",
  },
  hide: {
    title: "Hide conversation",
    detail:
      "Hide this conversation from your sidebar only. Messages and membership are kept; other participants are not removed.",
  },
} as const;

export function ChannelLifecycleDialog({
  channelId,
  channelName,
  action,
  lifecycle,
  close,
  completed,
}: {
  channelId: string;
  channelName: string;
  action: ChannelLifecycleAction;
  lifecycle: ChannelLifecycleCapability;
  close(): void;
  completed(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshRequired, setRefreshRequired] = useState(false);
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    return () => {
      operation.current?.abort();
    };
  }, []);
  const submit = async () => {
    if (operation.current || refreshRequired) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      await lifecycle.run(action, channelId, controller.signal);
      if (!controller.signal.aborted) completed();
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : String(error));
        setRefreshRequired(error instanceof ChannelLifecycleUnconfirmed);
      }
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <Dialog
      open
      dismissOnOutsideClick
      preventClose={busy}
      initialFocus={cancel}
      // The sidebar owns both cancellation and completed-navigation focus.
      finalFocus={false}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`${copy[action].title}: ${channelName}`}
      description={copy[action].detail}
      actions={
        <>
          <Button ref={cancel} type="button" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={action === "delete" ? "destructive" : "prominent"}
            loading={busy}
            disabled={refreshRequired}
            onClick={() => void submit()}
          >
            {copy[action].title}
          </Button>
        </>
      }
    >
      {error && <p role="alert">{error}</p>}
      {busy && (
        <p role="status" className="sr-only">
          Checking permissions and waiting for relay confirmation…
        </p>
      )}
    </Dialog>
  );
}
