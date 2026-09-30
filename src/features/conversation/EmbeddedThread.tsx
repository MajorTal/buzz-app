import type { Context } from "@deepseek-ai/cordis";
import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { buzzLinkTarget } from "../navigation/buzz-links";
import { PanelView } from "../panels/PanelView";
import type { RegisteredPanel } from "../panels/service";
import { MediaReviewViewer } from "../messages/MediaReviewViewer";
import {
  MessageManagement,
  MessageManagementStatus,
} from "../messages/MessageManagement";
import { ThreadPanel, type ThreadPanelProps } from "../messages/ThreadPanel";
import { messageViewKey } from "../messages/view-key";

/** The host owns conversation behavior; the page owns its task and placement. */
export type EmbeddedThreadProps = Pick<
  ThreadPanelProps,
  "session" | "scope" | "channelId" | "channelName" | "messageId"
>;
type Props = EmbeddedThreadProps & {
  host: Context;
  extensions: NonNullable<ThreadPanelProps["extensions"]>;
};
/** At most one modal surface: opening a panel or a media review replaces the other. */
type Overlay =
  | { panel: RegisteredPanel; target: string; media?: undefined }
  | {
      media: Pick<
        ComponentProps<typeof MediaReviewViewer>,
        "messageId" | "attachment" | "initialTime" | "hasComments"
      >;
      panel?: undefined;
    };

/**
 * As in Channels, the channel visit and message recovery span threads of one
 * channel; retargeting remounts only the thread and its overlay.
 */
export function EmbeddedThread(props: Props) {
  const { session, scope, channelId, messageId } = props;
  return (
    <MessageManagement
      key={messageViewKey(session, scope, channelId)}
      session={session}
      channelId={channelId}
    >
      <MessageManagementStatus />
      <OwnedEmbeddedThread key={messageId} {...props} />
    </MessageManagement>
  );
}

function OwnedEmbeddedThread({ host, extensions, ...props }: Props) {
  const { session, scope, channelId, channelName } = props;
  const viewer = scope.slice(-64);
  const relayUrl = scope.slice(0, -65);
  const panels = useSyncExternalStore(
    host.panels.subscribe,
    host.panels.snapshot,
  );
  const { channels } = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const [overlay, setOverlay] = useState<Overlay>();
  // A panel never outlives its contribution.
  if (overlay?.panel && !panels.includes(overlay.panel)) setOverlay(undefined);
  // Captured callbacks may run late: nothing acts after unmount, and a plugin
  // panel acts only while it is still the overlay on screen.
  const mounted = useRef(false);
  const shown = useRef(overlay);
  useLayoutEffect(() => {
    mounted.current = true;
    shown.current = overlay;
    return () => {
      mounted.current = false;
    };
  }, [overlay]);
  const active = () => {
    const connection = host.relay.snapshot();
    return (
      mounted.current &&
      connection.status === "ready" &&
      connection.session === session &&
      connection.scope === scope
    );
  };
  const canOpen = (target: string) => !!host.panels.resolve(target);
  const open = (url: string) => {
    if (!active()) return false;
    const target = buzzLinkTarget(url, { viewer, communityOrigin: relayUrl });
    if (target) {
      setOverlay(undefined);
      void host.navigation.open(target);
      return true;
    }
    const panel = host.panels.resolve(url);
    if (!panel) return false;
    setOverlay({ panel, target: url });
    return true;
  };
  return (
    <>
      <ThreadPanel
        {...props}
        sessionConversation={channels.some(
          (channel) =>
            channel.id === channelId && channel.channelType === "session",
        )}
        extensions={extensions}
        onOpenLink={open}
        canOpenLink={canOpen}
        onOpenMediaReview={(
          messageId,
          attachment,
          initialTime,
          hasComments = false,
        ) => {
          if (active())
            setOverlay({
              media: { messageId, attachment, initialTime, hasComments },
            });
        }}
      />
      {overlay?.panel && (
        <Dialog
          open
          title={overlay.panel.title}
          placement="right"
          height="stable"
          onOpenChange={(next) => {
            if (!next) setOverlay(undefined);
          }}
        >
          <PanelView
            panel={overlay.panel}
            target={overlay.target}
            close={() => {
              if (shown.current === overlay) setOverlay(undefined);
            }}
            channelContext={{
              scope,
              channelId,
              channelName,
              viewer,
              relayUrl,
              threadId: props.messageId,
            }}
            context={{
              channelId,
              canOpen,
              open: (target) =>
                shown.current === overlay &&
                host.panels.snapshot().includes(overlay.panel) &&
                open(target),
            }}
          />
        </Dialog>
      )}
      {overlay?.media && (
        <MediaReviewViewer
          {...overlay.media}
          session={session}
          scope={scope}
          channelId={channelId}
          channelName={channelName}
          extensions={extensions}
          onOpenLink={open}
          close={() => setOverlay(undefined)}
        />
      )}
    </>
  );
}
