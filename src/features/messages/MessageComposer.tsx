import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { TypingIndicator } from "./TypingIndicator";
import { IconArrowUp as ArrowUp, IconX as X } from "@tabler/icons-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { messageViewKey } from "./view-key";
import { extendEmojiSelection } from "./emoji-selection";
import {
  customEmojiOnlySpans,
  isEmojiOnly,
  leadingCustomEmojiSpans,
  usesLargeEmojiPresentation,
} from "./emoji-size";
import {
  mentionDraft,
  editMentionDraft,
  replaceMentionDraft,
  type MentionDraft,
  type MentionEdit,
  type MentionRecipient,
} from "./mention-draft";
import { ComposerTools } from "../conversation/ComposerTools";
import type {
  ConversationExtensions,
  CompletionEdit,
  CompletionQuery,
  ComposerObservation,
} from "../conversation/contracts";
import { ComposerCompletions } from "../conversation/ComposerCompletions";
import { useCompletionEditor } from "../conversation/useCompletionEditor";
import { RichComposerInput } from "./RichComposerInput";
import type { ComposerInputElement } from "./composer-dom";

export type MessageComposerProps = {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  session: RelaySession;
  channelId: string;
  channelName: string;
  onSend?: (id: string) => void;
  threadRootId?: string;
  disabled?: boolean;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function MessageComposer(props: MessageComposerProps) {
  return (
    <Composer
      key={messageViewKey(
        props.session,
        props.scope,
        props.channelId,
        props.threadRootId,
      )}
      {...props}
    />
  );
}
function Composer({
  session,
  extensions,
  scope,
  channelId,
  channelName,
  onSend,
  threadRootId,
  disabled = false,
}: MessageComposerProps) {
  const inputId = useId();
  const draftKey = threadRootId
    ? `draft:${channelId}:thread:${threadRootId}`
    : `draft:${channelId}`;
  const label = threadRootId ? "Reply to thread" : `Message #${channelName}`;
  const [value, updateDraft] = useState(() =>
    mentionDraft(readView<unknown>(scope, draftKey, "")),
  );
  const draft = value.text;
  const valueRef = useRef(value);
  const caret = useRef<number | undefined>(undefined);
  const input = useRef<ComposerInputElement>(null);
  const restoreSelection = useRef<{ start: number; end: number } | undefined>(
    undefined,
  );
  const compositionSaved = useRef(false);
  const history = useRef<{
    past: { draft: MentionDraft; start: number; end: number }[];
    future: { draft: MentionDraft; start: number; end: number }[];
  }>({ past: [], future: [] });
  const saveDraft = (
    next: MentionDraft,
    before?: { start: number; end: number },
  ) => {
    if (
      next.text === valueRef.current.text &&
      JSON.stringify(next.recipients) ===
        JSON.stringify(valueRef.current.recipients)
    )
      return;
    if (!compositionSaved.current)
      history.current.past.push({
        draft: valueRef.current,
        start: before?.start ?? input.current?.selectionStart ?? 0,
        end: before?.end ?? input.current?.selectionEnd ?? 0,
      });
    if (completion.composing.current) compositionSaved.current = true;
    history.current.past = history.current.past.slice(-100);
    history.current.future = [];
    valueRef.current = next;
    updateDraft(next);
    writeView(scope, draftKey, next);
  };
  const setDraft = (text: string) =>
    saveDraft(editMentionDraft(valueRef.current, text));
  const [error, setError] = useState<string>();
  const outbox = session.outbox;
  const emojiCatalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const customEmojiOnly = customEmojiOnlySpans(draft, emojiCatalog.entries);
  const customEmojiSpans = (
    customEmojiOnly.length
      ? customEmojiOnly
      : leadingCustomEmojiSpans(draft, emojiCatalog.entries).spans
  ).filter(({ emoji }) => !!session.media(emoji.url));
  const largeEmojiDraft = usesLargeEmojiPresentation(
    draft,
    emojiCatalog.entries,
  );
  const edit = useRef<MentionEdit | undefined>(undefined);
  const completion = useCompletionEditor(
    input,
    !disabled && !!outbox?.supports(9),
  );
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const capture = (event: InputEvent) => {
      edit.current = {
        text: element.value,
        start: element.selectionStart,
        end: element.selectionEnd,
        inputType: event.isComposing
          ? "insertCompositionText"
          : event.inputType,
      };
    };
    element.addEventListener("beforeinput", capture);
    return () => element.removeEventListener("beforeinput", capture);
  }, []);
  useEffect(() => {
    if (outbox?.supports(9)) void session.emoji.ensure();
  }, [session, outbox]);
  useLayoutEffect(() => {
    if (restoreSelection.current) {
      const { start, end } = restoreSelection.current;
      input.current?.focus();
      input.current?.setSelectionRange(start, end);
      restoreSelection.current = undefined;
      return;
    }
    if (caret.current === undefined) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  function undo(redo: boolean) {
    if (disabled || input.current?.readOnly || completion.composing.current)
      return;
    const source = redo ? history.current.future : history.current.past;
    const destination = redo ? history.current.past : history.current.future;
    const next = source.pop();
    if (!next) return;
    destination.push({
      draft: valueRef.current,
      start: input.current?.selectionStart ?? 0,
      end: input.current?.selectionEnd ?? 0,
    });
    valueRef.current = next.draft;
    updateDraft(next.draft);
    writeView(scope, draftKey, next.draft);
    caret.current = undefined;
    restoreSelection.current = { start: next.start, end: next.end };
    completion.invalidate();
  }
  function insert(
    text: string,
    recipient?: MentionRecipient,
    range?: CompletionQuery,
  ) {
    if (
      disabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected ||
      // DOM props are committed before child layout effects; closures can still
      // carry the preceding render's enabled state during that interval.
      input.current.disabled ||
      input.current.readOnly ||
      typeof text !== "string"
    )
      return false;
    const current = valueRef.current;
    const start = range?.start ?? caret.current ?? input.current.selectionStart;
    const end = range?.end ?? caret.current ?? input.current.selectionEnd;
    const edited = replaceMentionDraft(current, start, end, text);
    if (edited.text.length > 16000) {
      setError("Message is too long to insert text");
      return false;
    }
    if (recipient && edited.recipients.length >= 32) {
      setError("Choose at most 32 recipients");
      return false;
    }
    const next = recipient
      ? mentionDraft({
          text: edited.text,
          recipients: [
            ...edited.recipients,
            { ...recipient, start, end: start + text.length - 1 },
          ],
        })
      : edited;
    completion.invalidate();
    caret.current = start + text.length;
    saveDraft(next);
    setError(undefined);
    return true;
  }
  function insertMention(recipient: MentionRecipient) {
    if (
      !recipient ||
      typeof recipient.pubkey !== "string" ||
      !/^[0-9a-f]{64}$/.test(recipient.pubkey) ||
      typeof recipient.name !== "string" ||
      !recipient.name.trim()
    )
      return false;
    return insert(`@${recipient.name} `, recipient);
  }
  function replaceCompletion(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
  ) {
    if (
      !completion.valid(observation) ||
      valueRef.current.text !== observation.text
    )
      return false;
    if ("mention" in edit && edit.mention)
      return insert(`@${edit.mention.name} `, edit.mention, query);
    return (
      typeof edit.text === "string" &&
      insert(
        `${edit.text}${isEmojiOnly(edit.text, emojiCatalog.entries) ? "" : " "}`,
        undefined,
        query,
      )
    );
  }
  function send() {
    if (
      disabled ||
      input.current?.readOnly ||
      input.current?.disabled ||
      !draft.trim() ||
      !outbox
    )
      return;
    try {
      const id = threadRootId
        ? session.messages.reply(
            channelId,
            threadRootId,
            draft,
            value.recipients.map((item) => item.pubkey),
          )
        : session.messages.send(
            channelId,
            draft,
            value.recipients.map((item) => item.pubkey),
          );
      onSend?.(id);
      completion.invalidate();
      setDraft("");
      history.current = { past: [], future: [] };
      input.current?.focus();
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  if (!outbox?.supports(9))
    return (
      <footer className={styles.composer}>
        <TypingIndicator
          session={session}
          channelId={channelId}
          threadRootId={threadRootId}
        />
        This relay connection supports reading only.
      </footer>
    );
  return (
    <form
      className={styles.composer}
      aria-label={
        threadRootId ? "Reply to thread" : `Send a message to ${channelName}`
      }
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {!disabled && (
        <TypingIndicator
          session={session}
          channelId={channelId}
          threadRootId={threadRootId}
        />
      )}
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      {extensions?.completions && (
        <ComposerCompletions
          registry={extensions.completions}
          editor={completion}
          input={input}
          session={session}
          scope={scope}
          channelId={channelId}
          threadRootId={threadRootId}
          replace={replaceCompletion}
        />
      )}
      <div className={styles.composerInput}>
        <RichComposerInput
          ref={input}
          id={inputId}
          disabled={disabled}
          value={draft}
          draft={value}
          session={session}
          scope={scope}
          channelId={channelId}
          extensions={extensions}
          emoji={emojiCatalog.entries}
          onUndo={undo}
          data-single-emoji={largeEmojiDraft || undefined}
          maxLength={16000}
          placeholder={label}
          onFocus={() => completion.observe(true)}
          onBlur={() => {
            completion.invalidate();
          }}
          onSelect={() => {
            completion.observe();
          }}
          onCompositionStart={() => {
            compositionSaved.current = false;
            completion.composing.current = true;
            completion.invalidate();
          }}
          onCompositionEnd={() => {
            compositionSaved.current = false;
            completion.composing.current = false;
            completion.observe(true);
          }}
          // onInput also observes same-text replacements, which onChange omits.
          onInput={(event) => {
            const range = edit.current;
            edit.current = undefined;
            saveDraft(
              editMentionDraft(
                valueRef.current,
                event.currentTarget.value,
                range,
              ),
              range,
            );
            completion.observe(true);
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 ||
              completion.composing.current
            )
              return;
            if (
              event.shiftKey &&
              ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
            ) {
              completion.invalidate();
              if (
                customEmojiSpans.length &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                (event.key === "ArrowLeft" || event.key === "ArrowRight")
              ) {
                const next = extendEmojiSelection(
                  customEmojiSpans,
                  event.currentTarget,
                  event.key,
                );
                if (next) {
                  event.preventDefault();
                  event.currentTarget.setSelectionRange(
                    next.start,
                    next.end,
                    next.direction,
                  );
                }
              }
              return;
            }
            if (completion.keys.current?.(event)) return;
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
      </div>
      {!!value.recipients.length && (
        <section
          className={styles.mentionRecipients}
          aria-label="Notification recipients"
        >
          <span>Notify:</span>
          {value.recipients.map((recipient) => (
            <Button
              size="sm"
              type="button"
              key={`${recipient.pubkey}:${recipient.start}`}
              title={recipient.pubkey}
              aria-label={`Remove mention ${recipient.name} ${recipient.pubkey}`}
              onClick={() =>
                saveDraft({
                  ...value,
                  recipients: value.recipients.filter(
                    (item) => item.pubkey !== recipient.pubkey,
                  ),
                })
              }
            >
              {recipient.name} <code>{recipient.pubkey.slice(0, 8)}</code>
              <X size={12} aria-hidden="true" />
            </Button>
          ))}
        </section>
      )}
      <div className={styles.composerActions}>
        <div className={styles.composerTools}>
          {extensions && (
            <ComposerTools
              registry={extensions.tools}
              session={session}
              scope={scope}
              channelId={channelId}
              threadRootId={threadRootId}
              disabled={disabled}
              insertText={(text) => insert(text)}
              insertMention={insertMention}
              focus={() => input.current?.focus()}
            />
          )}
        </div>
        <span className={styles.composerHint}>
          Shift + Enter for a new line
        </span>
        <IconButton
          size="toolbar"
          variant="solid"
          shape="round"
          type="submit"
          aria-label="Send message"
          title="Send message"
          disabled={disabled || !draft.trim()}
          icon={<ArrowUp size={18} aria-hidden="true" />}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {error && session.emoji?.snapshot().status === "error" && (
        <Button
          size="sm"
          type="button"
          disabled={disabled}
          onClick={() => {
            void session.emoji.refresh().then(() => {
              if (
                input.current?.isConnected &&
                session.emoji.snapshot().status === "ready"
              )
                setError(undefined);
            });
          }}
        >
          Retry message preparation
        </Button>
      )}
    </form>
  );
}
