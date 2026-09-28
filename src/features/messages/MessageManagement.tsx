import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { MenuItem, MenuSeparator } from "../../shared/design-system/ui/Menu";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { OutgoingEvent } from "../relay/outbox";
import { MessageEditScope, useMessageEditScope } from "./MessageEditScope";
import { useAfterMessageMenuClose } from "./MessageActionBar";
import { lastEditableMessage } from "./useMessageEdit";
import styles from "./Messages.module.css";

const emptyOperations: readonly OutgoingEvent[] = Object.freeze([]);
const empty = () => emptyOperations;
const noop = () => () => {};
type Deletion = {
  row: ChannelMessage;
  done?: (() => void) | undefined;
  focus?: (() => HTMLElement | null) | undefined;
};
const Management = createContext<
  | {
      remove(
        row: ChannelMessage,
        done?: () => void,
        focus?: () => HTMLElement | null,
      ): void;
      operations: readonly OutgoingEvent[];
      session: RelaySession;
      channelId?: string | undefined;
    }
  | undefined
>(undefined);
export function useMessageDeletion() {
  const management = useContext(Management);
  const editor = useMessageEditScope();
  return management
    ? (row: ChannelMessage, done?: () => void) =>
        management.remove(row, done, () => editor?.focusTarget() ?? null)
    : undefined;
}

/** Recovery stays outside virtualized rows; each conversation has one edit destination. */
export function MessageManagement({
  session,
  channelId,
  children,
}: {
  session: RelaySession;
  channelId?: string | undefined;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<Deletion>();
  const operations = useSyncExternalStore(
    session.outbox?.subscribe ?? noop,
    session.outbox?.snapshot ?? empty,
  );
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const available =
    !selection ||
    ((!channelId || channelId === selection.row.channelId) &&
      channels.channels.some(
        (channel) =>
          channel.id === selection.row.channelId && !channel.readOnly,
      ));
  useEffect(() => {
    if (!available) setSelection(undefined);
  }, [available]);
  return (
    <Management.Provider
      value={{
        session,
        channelId,
        operations,
        remove(row, done, focus) {
          setSelection({ row, done, focus });
        },
      }}
    >
      <MessageEditScope>{children}</MessageEditScope>
      {selection && available && (
        <DeleteMessageDialog
          key={selection.row.id}
          session={session}
          selection={selection}
          operations={operations}
          close={() => setSelection(undefined)}
        />
      )}
    </Management.Provider>
  );
}

export function MessageManagementItems({
  row,
  session,
  separated = false,
}: {
  row: ChannelMessage;
  session: RelaySession;
  separated?: boolean;
}) {
  const management = useContext(Management);
  const editor = useMessageEditScope();
  const afterClose = useAfterMessageMenuClose();
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  if (
    !management ||
    row.membership ||
    row.diff ||
    (row.delivery && !["accepted", "seen"].includes(row.delivery))
  )
    return null;
  const member = channels.channels.find(
    (channel) => channel.id === row.channelId,
  );
  if (!member || member.readOnly) return null;
  const busy = management.operations.some(
    (item) =>
      ["sending", "accepted"].includes(item.delivery) &&
      [5, 40003].includes(item.event.kind) &&
      item.event.tags.some(([name, id]) => name === "e" && id === row.id),
  );
  const own = row.authorId === session.viewer && !member.archived;
  const canEdit = own && editor && lastEditableMessage(session, [row]);
  const canDelete = own && session.outbox?.supports(5);
  const act = (action: () => void) =>
    afterClose ? afterClose(action) : action();
  return (
    <>
      {separated && (canEdit || canDelete) && <MenuSeparator />}
      {canEdit && (
        <MenuItem
          disabled={
            busy ||
            management.operations.some(
              (item) =>
                item.event.kind === 5 &&
                item.event.tags.some(
                  ([name, id]) => name === "e" && id === row.id,
                ),
            )
          }
          onClick={() => act(() => editor.current?.(row))}
        >
          Edit message
        </MenuItem>
      )}
      {canDelete && (
        <MenuItem
          disabled={
            busy ||
            management.operations.some(
              (item) =>
                item.event.kind === 40003 &&
                item.event.tags.some(
                  ([name, id]) => name === "e" && id === row.id,
                ),
            )
          }
          onClick={() =>
            act(() =>
              management.remove(
                row,
                undefined,
                () => editor?.focusTarget() ?? null,
              ),
            )
          }
        >
          Delete message
        </MenuItem>
      )}
    </>
  );
}

function DeleteMessageDialog({
  session,
  selection,
  operations,
  close,
}: {
  session: RelaySession;
  selection: Deletion;
  operations: readonly OutgoingEvent[];
  close(): void;
}) {
  const { row } = selection;
  const [operationId, setOperationId] = useState(
    () =>
      operations.find(
        (item) =>
          item.event.kind === 5 &&
          item.event.tags.some(([name, id]) => name === "e" && id === row.id),
      )?.event.id,
  );
  const [error, setError] = useState<string>();
  const operation = operations.find((item) => item.event.id === operationId);
  const pending = operation?.delivery === "sending";
  const retryable =
    operation?.delivery === "failed" || operation?.delivery === "unknown";
  useEffect(() => {
    if (
      operationId &&
      (!operation ||
        operation.delivery === "seen" ||
        operation.delivery === "accepted")
    ) {
      selection.done?.();
      close();
    }
  }, [operationId, operation, selection, close]);
  const run = () => {
    setError(undefined);
    try {
      if (
        !session.channels
          .list()
          .channels.some(
            (channel) =>
              channel.id === row.channelId &&
              !channel.archived &&
              !channel.readOnly,
          )
      )
        throw new Error(
          "This conversation is no longer available for changes.",
        );
      if (operationId) session.outbox?.retry(operationId);
      else setOperationId(session.messages.remove([row.id]));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not delete this message. Try again.",
      );
    }
  };
  return (
    <AlertDialog
      title="Delete message?"
      description="Request deletion of this message from the conversation. People may still have copies. This cannot be undone."
      pending={pending}
      finalFocus={() => (operationId ? (selection.focus?.() ?? true) : true)}
      onClose={close}
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            {operationId ? "Close" : "Cancel"}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={run}>
            {pending ? "Deleting…" : retryable ? "Retry" : "Delete"}
          </Button>
        </>
      }
    >
      {(error || retryable) && (
        <p role="alert">
          {error ??
            operation?.error ??
            "Delivery could not be confirmed. Retry sends the same operation."}
        </p>
      )}
    </AlertDialog>
  );
}

/** Recovery survives a removed row, closed dialog, navigation and restored outbox. */
export function MessageManagementStatus() {
  const management = useContext(Management);
  const [error, setError] = useState<string>();
  if (!management) return null;
  const { session, channelId, operations } = management;
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === channelId);
  const pending = operations.filter(
    (item) =>
      (item.event.kind === 40003 ||
        (item.event.kind === 5 &&
          item.event.tags.some(
            ([name, kind]) =>
              name === "k" && ["9", "40002"].includes(kind ?? ""),
          ))) &&
      item.event.tags.some(([name, id]) => name === "h" && id === channelId) &&
      ["failed", "unknown"].includes(item.delivery),
  );
  return (
    <>
      {pending.map((item) => (
        <div
          key={item.event.id}
          className={styles.messageActionNotice}
          role="status"
        >
          <p>
            {item.event.kind === 40003 ? "Message edit" : "Message deletion"}:{" "}
            {item.error ?? "Delivery could not be confirmed."}
          </p>
          {item.event.kind === 40003 && <p>{item.event.content}</p>}
          {item.delivery === "unknown" && (
            <p>
              This may already have reached the conversation. Retry sends the
              same operation; dismissing does not undo it.
            </p>
          )}
          <Button
            disabled={!channel || channel.archived || channel.readOnly}
            onClick={() => session.outbox?.retry(item.event.id)}
          >
            Retry message update
          </Button>
          <Button
            onClick={async () => {
              try {
                await session.outbox?.dismiss(item.event.id);
                setError(undefined);
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not dismiss the operation.",
                );
              }
            }}
          >
            {item.delivery === "failed"
              ? "Discard failed update"
              : "Dismiss unconfirmed update"}
          </Button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
