import { ArrowUp, X } from "lucide-react";
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
  const saveDraft = (next: MentionDraft) => {
    valueRef.current = next;
    updateDraft(next);
    writeView(scope, draftKey, next);
  };
  const setDraft = (text: string) =>
    saveDraft(editMentionDraft(valueRef.current, text));
  const [error, setError] = useState<string>();
  const [failedCustomEmoji, setFailedCustomEmoji] = useState<string>();
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const outbox = session.outbox;
  const emojiCatalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const customEmojiOnly = customEmojiOnlySpans(draft, emojiCatalog.entries);
  const leadingCustomEmoji = customEmojiOnly.length
    ? { spans: [], end: 0 }
    : leadingCustomEmojiSpans(draft, emojiCatalog.entries);
  const customEmoji = customEmojiOnly.length
    ? customEmojiOnly
    : leadingCustomEmoji.spans;
  const customEmojiSources = customEmoji.map(({ emoji, start, end }) => ({
    start,
    end,
    key: `${start}:${emoji.shortcode}`,
    source: session.media(emoji.url),
  }));
  const showCustomEmoji =
    !!customEmojiSources.length &&
    customEmojiSources.every(
      ({ source }) => !!source && source !== failedCustomEmoji,
    );
  const showCustomEmojiOnly = showCustomEmoji && customEmojiOnly.length > 0;
  const showLeadingCustomEmoji =
    showCustomEmoji &&
    !customEmojiOnly.length &&
    !!leadingCustomEmoji.spans.length;
  const input = useRef<HTMLTextAreaElement>(null);
  const customEmojiMirror = useRef<HTMLSpanElement>(null);
  const customEmojiGroup = useRef<HTMLSpanElement>(null);
  const [customEmojiLayout, setCustomEmojiLayout] = useState({
    left: 0,
    top: 0,
    height: 48,
  });
  useLayoutEffect(() => {
    if (!showCustomEmojiOnly) return;
    const group = customEmojiGroup.current;
    const last = group?.children[customEmojiOnly.length - 1];
    if (!group || !last || !(last instanceof HTMLElement)) return;
    const resize = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(input.current ?? group).lineHeight,
      );
      const next = {
        left: Math.min(
          last.offsetLeft + last.offsetWidth + 2,
          Math.max(0, group.clientWidth - 2),
        ),
        top: last.offsetTop,
        height: last.offsetTop + lineHeight,
      };
      setCustomEmojiLayout((current) =>
        current.left === next.left &&
        current.top === next.top &&
        current.height === next.height
          ? current
          : next,
      );
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(group);
    return () => observer.disconnect();
  }, [showCustomEmojiOnly, customEmojiOnly.length]);
  useLayoutEffect(() => {
    const element = input.current;
    if (
      showCustomEmojiOnly &&
      element &&
      element.selectionStart === draft.length &&
      element.selectionEnd === draft.length
    )
      element.scrollTop = Math.max(
        0,
        customEmojiLayout.height - element.clientHeight,
      );
  }, [showCustomEmojiOnly, customEmojiLayout.height, draft.length]);
  const inlineEmojiGroup = useRef<HTMLSpanElement>(null);
  const inlinePrefixMeasure = useRef<HTMLSpanElement>(null);
  const [inlineTextIndent, setInlineTextIndent] = useState(0);
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
    if (caret.current === undefined) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  useLayoutEffect(() => {
    if (!showLeadingCustomEmoji) {
      setInlineTextIndent(0);
      return;
    }
    const emoji = inlineEmojiGroup.current;
    const prefix = inlinePrefixMeasure.current;
    if (
      !emoji ||
      !prefix ||
      typeof emoji.getBoundingClientRect !== "function" ||
      typeof prefix.getBoundingClientRect !== "function"
    )
      return;
    const resize = () => {
      const next =
        emoji.getBoundingClientRect().width -
        prefix.getBoundingClientRect().width;
      setInlineTextIndent((current) =>
        Math.abs(current - next) < 0.25 ? current : next,
      );
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(emoji);
    observer.observe(prefix);
    return () => observer.disconnect();
  }, [showLeadingCustomEmoji]);
  useLayoutEffect(() => {
    const mirror = customEmojiMirror.current;
    if (mirror) mirror.scrollTop = input.current?.scrollTop ?? 0;
    if (customEmojiGroup.current)
      customEmojiGroup.current.style.transform = `translateY(-${input.current?.scrollTop ?? 0}px)`;
  });
  function syncCustomEmojiScroll(element: HTMLTextAreaElement) {
    if (customEmojiMirror.current)
      customEmojiMirror.current.scrollTop = element.scrollTop;
    if (customEmojiGroup.current)
      customEmojiGroup.current.style.transform = `translateY(-${element.scrollTop}px)`;
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
    if (disabled || !draft.trim() || !outbox) return;
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
      input.current?.focus();
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  if (!outbox?.supports(9))
    return (
      <footer className={styles.composer}>
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
        <textarea
          ref={input}
          id={inputId}
          disabled={disabled}
          value={draft}
          data-single-emoji={usesLargeEmojiPresentation(draft) || undefined}
          data-custom-emoji-only={showCustomEmojiOnly || undefined}
          data-leading-custom-emoji={showLeadingCustomEmoji || undefined}
          style={
            showCustomEmojiOnly
              ? {
                  paddingLeft: customEmojiLayout.left,
                  paddingTop: customEmojiLayout.top,
                  height: customEmojiLayout.height,
                }
              : showLeadingCustomEmoji
                ? { textIndent: `${inlineTextIndent}px` }
                : undefined
          }
          maxLength={16000}
          rows={2}
          placeholder={label}
          onFocus={() => completion.observe(true)}
          onScroll={(event) => syncCustomEmojiScroll(event.currentTarget)}
          onBlur={() => {
            setSelection({ start: 0, end: 0 });
            completion.invalidate();
          }}
          onSelect={(event) => {
            setSelection({
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            });
            completion.observe();
          }}
          onCompositionStart={() => {
            completion.composing.current = true;
            completion.invalidate();
          }}
          onCompositionEnd={() => {
            completion.composing.current = false;
            completion.observe(true);
          }}
          // onInput also observes same-text replacements, which onChange omits.
          onChange={() => {}}
          onInput={(event) => {
            const range = edit.current;
            edit.current = undefined;
            saveDraft(
              editMentionDraft(
                valueRef.current,
                event.currentTarget.value,
                range,
              ),
            );
            setSelection({ start: 0, end: 0 });
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
                showCustomEmoji &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                (event.key === "ArrowLeft" || event.key === "ArrowRight")
              ) {
                const next = extendEmojiSelection(
                  customEmojiSources,
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
                  setSelection({ start: next.start, end: next.end });
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
        {showCustomEmojiOnly && (
          <span
            ref={customEmojiGroup}
            className={styles.composerCustomEmojiGroup}
            aria-hidden="true"
          >
            {customEmojiSources.map(({ start, end, key, source }) => (
              <img
                key={key}
                className={styles.composerCustomEmoji}
                data-selected={
                  (selection.start < end && selection.end > start) || undefined
                }
                src={source}
                alt=""
                onError={() => setFailedCustomEmoji(source)}
              />
            ))}
          </span>
        )}
        {showLeadingCustomEmoji && (
          <span
            ref={customEmojiMirror}
            className={styles.composerCustomEmojiMirror}
            aria-hidden="true"
          >
            <span
              ref={inlineEmojiGroup}
              className={styles.composerInlineCustomEmojiGroup}
              data-composer-inline-emoji=""
            >
              {customEmojiSources.map(({ start, end, key, source }) => (
                <img
                  key={key}
                  className={styles.composerCustomEmoji}
                  data-selected={
                    (selection.start < end && selection.end > start) ||
                    undefined
                  }
                  src={source}
                  alt=""
                  onError={() => setFailedCustomEmoji(source)}
                />
              ))}
            </span>
            <span data-composer-inline-text="">
              {draft.slice(leadingCustomEmoji.end)}
            </span>
            <span
              ref={inlinePrefixMeasure}
              className={styles.composerCustomEmojiPrefixMeasure}
              data-composer-custom-emoji-prefix=""
            >
              {draft.slice(0, leadingCustomEmoji.end)}
            </span>
          </span>
        )}
      </div>
      {!!value.recipients.length && (
        <section
          className={styles.mentionRecipients}
          aria-label="Notification recipients"
        >
          <span>Notify:</span>
          {value.recipients.map((recipient) => (
            <button
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
            </button>
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
        <button
          className={styles.sendButton}
          type="submit"
          aria-label="Send message"
          title="Send message"
          disabled={disabled || !draft.trim()}
        >
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {error && session.emoji?.snapshot().status === "error" && (
        <button
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
        </button>
      )}
    </form>
  );
}
