import { Button } from "../../shared/design-system/ui/Button";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ConversationExtensions } from "../conversation/contracts";
import type { PageNavigation } from "../navigation/service";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { useRowProfiles } from "../relay/react";
import { useMessageEditScope } from "../messages/MessageEditScope";
import { MessageRow } from "../messages/MessageRow";
import { useMessageReveal } from "../messages/use-message-reveal";
import { useReading } from "../messages/use-reading";
import messages from "../messages/Messages.module.css";
import styles from "./Sessions.module.css";

type Props = {
  session: RelaySession;
  scope: string;
  channelId: string;
  messageId: string;
  navigation: PageNavigation;
  extensions?: ConversationExtensions | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  onLatest(): void;
  onRetry(): void;
};

/** An isolated verified target is not a contiguous page of session history. */
export function SessionMessageTarget(props: Props) {
  const { session, channelId, messageId, navigation } = props;
  const [failed, setFailed] = useState<PageNavigation>();
  const [owned, setOwned] = useState<{
    request: PageNavigation;
    view: ThreadView;
  }>();
  useEffect(() => {
    if (navigation.signal.aborted) return;
    try {
      const view = session.thread(channelId, messageId, { exact: true });
      const cancel = () => {
        view.dispose();
        setOwned(undefined);
      };
      setOwned({ request: navigation, view });
      navigation.signal.addEventListener("abort", cancel, { once: true });
      void view.refresh();
      return () => {
        navigation.signal.removeEventListener("abort", cancel);
        view.dispose();
      };
    } catch {
      setFailed(navigation);
      navigation.complete({ status: "failed", reason: "unavailable" });
    }
  }, [session, channelId, messageId, navigation]);
  return (
    <div className={styles.timeline}>
      <div className={styles.targetNavigation}>
        <span>Selected message</span>
        <Button type="button" onClick={props.onLatest}>
          Back to latest
        </Button>
      </div>
      {failed === navigation || navigation.signal.aborted ? (
        <UnavailableMessage onRetry={props.onRetry} />
      ) : owned?.request === navigation ? (
        <SelectedMessage {...props} view={owned.view} />
      ) : (
        <p className={messages.empty} role="status">
          Loading selected message…
        </p>
      )}
    </div>
  );
}

function SelectedMessage({
  session,
  scope,
  channelId,
  messageId,
  navigation,
  extensions,
  onOpenLink,
  canOpenLink,
  view,
  onRetry,
}: Props & { view: ThreadView }) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const editor = useMessageEditScope();
  useEffect(() => {
    if (!editor) return;
    // Read the exact owner's current projection at edit time, not a captured row
    // or a timeline insertion. Aborted/deleted targets must stay unavailable.
    const exactRows = () => {
      const current = view.snapshot();
      return !navigation.signal.aborted &&
        current.targetStatus === "ready" &&
        current.target
        ? [current.target]
        : [];
    };
    editor.exactRows = exactRows;
    return () => {
      if (editor.exactRows === exactRows) editor.exactRows = undefined;
    };
  }, [editor, view, navigation]);
  const target =
    snapshot.targetStatus === "ready" ? snapshot.target : undefined;
  const rows = useMemo(() => (target ? [target] : []), [target]);
  const profiles = useRowProfiles(session.profiles, rows);
  const scroller = useRef<HTMLElement>(null);
  const settled = useRef(false);
  const complete = useCallback(
    () => navigation.complete({ status: "opened" }),
    [navigation],
  );
  useMessageReveal({
    scroller,
    settled,
    messageId,
    signal: navigation.signal,
    ready: !!target,
    complete,
  });
  useReading({ session, channelId, scroller, settled });
  useEffect(() => {
    if (snapshot.targetStatus === "unavailable")
      navigation.complete({ status: "failed", reason: "not-found" });
    else if (snapshot.targetStatus === "error")
      navigation.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, snapshot.targetStatus]);
  useEffect(() => {
    if (target)
      void session.profiles
        .ensure(
          [
            target.authorId,
            ...target.mentions,
            ...(target.mentionReferences ?? []),
          ],
          "background",
        )
        .catch(() => {});
  }, [session, target]);
  return (
    <section
      ref={scroller}
      className={messages.feed}
      aria-label="Selected session message"
    >
      {target ? (
        <MessageRow
          row={target}
          session={session}
          scope={scope}
          unread={session.unread}
          extensions={extensions}
          profile={profiles.get(target.authorId)}
          participantProfiles={profiles}
          media={session.media}
          onOpenLink={onOpenLink}
          canOpenLink={canOpenLink}
          retry={session.outbox?.retry}
          day
        />
      ) : snapshot.targetStatus === "unavailable" ||
        snapshot.targetStatus === "error" ? (
        <UnavailableMessage onRetry={onRetry} />
      ) : (
        <p role="status">Loading selected message…</p>
      )}
    </section>
  );
}

function UnavailableMessage({ onRetry }: Pick<Props, "onRetry">) {
  return (
    <div className={messages.empty} role="alert">
      <p>The selected message could not be opened.</p>
      <Button type="button" onClick={onRetry}>
        Retry message
      </Button>
    </div>
  );
}
