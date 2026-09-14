import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Search, Smile, SmilePlus } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import type { RelaySession } from "../../features/relay/session";
import {
  communityFromScope,
  gifMarkdown,
  relaySupportsKlipy,
} from "../../features/relay/gifs";
import styles from "./Emoji.module.css";
import { GifPicker } from "./GifPicker";

const EMOJI_SIZE = 36;
const EMOJI_SLOT = 48;
const PICKER_COLUMN_CHROME = 44;
// Two balanced scrollbar lanes plus five gaps between six fixed-size slots.
const PICKER_CHROME = 72;

/** Reusable composer picker; data/signing remain owned by the community session. */
export function EmojiPicker({
  session,
  scope,
  disabled,
  insert,
  reaction = false,
}: {
  session: RelaySession;
  scope: string;
  disabled: boolean;
  insert(value: string): void;
  reaction?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"emoji" | "gifs">("emoji");
  const [animateTab, setAnimateTab] = useState(false);
  const [pressedTab, setPressedTab] = useState<"emoji" | "gifs">();
  const [gifAvailability, setGifAvailability] = useState<{
    community: string;
    supported: boolean | undefined;
  }>();
  const [gifDiscoveryRequested, setGifDiscoveryRequested] = useState(false);
  const [perLine, setPerLine] = useState(0);
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLFieldSetElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const search = useRef("");
  const onInsert = useRef(insert);
  onInsert.current = insert;
  const id = useId();
  const community = reaction ? undefined : communityFromScope(scope);
  const gifs = community
    ? gifAvailability?.community === community
      ? gifAvailability.supported
      : undefined
    : false;
  const showGifTab = gifs === true;
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  useEffect(() => {
    // The popover is positioned against the action row; intermediate tool groups
    // may be narrower and are not its available width.
    const container = reaction
      ? document.documentElement
      : controls.current?.offsetParent;
    if (!open || disabled || !(container instanceof HTMLElement)) return;
    const resize = () =>
      setPerLine(
        Math.max(
          1,
          Math.min(
            6,
            Math.floor(
              (container.clientWidth - PICKER_COLUMN_CHROME) / EMOJI_SLOT,
            ),
          ),
        ),
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [open, disabled, reaction]);
  useEffect(() => {
    if (
      !community ||
      !gifDiscoveryRequested ||
      (gifAvailability?.community === community &&
        gifAvailability.supported !== undefined)
    )
      return;
    const controller = new AbortController();
    void relaySupportsKlipy(community, controller.signal).then(
      (supported) => {
        if (!controller.signal.aborted) {
          setGifAvailability({ community, supported });
          if (!supported) {
            setAnimateTab(false);
            setPressedTab(undefined);
            setTab("emoji");
          }
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setGifAvailability({ community, supported: undefined });
          setGifDiscoveryRequested(false);
          setAnimateTab(false);
          setPressedTab(undefined);
          setTab("emoji");
        }
      },
    );
    return () => controller.abort();
  }, [community, gifDiscoveryRequested, gifAvailability]);
  useEffect(() => {
    if (!open || disabled || reaction) return;
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !controls.current?.contains(event.target)
      )
        setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, disabled, reaction]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed lazy import.
  useLayoutEffect(() => {
    if (!open || disabled || tab !== "emoji" || !host || !perLine) return;
    const container = host;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setError(undefined);
    // Keep the Unicode dataset and search work out of startup/channel opening.
    void import("./emoji-mart")
      .then(({ mountEmojiMart }) => {
        if (cancelled) return;
        dispose = mountEmojiMart({
          host: container,
          scope,
          perLine,
          emojiSize: EMOJI_SIZE,
          emojiButtonSize: EMOJI_SLOT,
          search: search.current,
          searchChange: (value) => {
            search.current = value;
          },
          entries: catalog.status === "ready" ? catalog.entries : [],
          media: session.media,
          select: (value) => {
            onInsert.current(value);
            setOpen(false);
          },
          close: () => setOpen(false),
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      search.current =
        container
          .querySelector("em-emoji-picker")
          ?.shadowRoot?.querySelector<HTMLInputElement>('input[type="search"]')
          ?.value ?? search.current;
      dispose?.();
    };
  }, [
    open,
    disabled,
    session,
    scope,
    catalog,
    attempt,
    perLine,
    tab,
    animateTab,
    host,
  ]);
  const picker = (
    <section
      id={id}
      className={`${styles.emojiPopover} ${reaction ? styles.reactionPopover : ""}`}
      aria-label="Emoji picker"
      data-has-tabs={showGifTab || undefined}
      style={{ width: perLine * EMOJI_SLOT + PICKER_CHROME + 2 }}
    >
      <Search
        className={styles.sharedSearchIcon}
        size={16}
        aria-hidden="true"
      />
      {showGifTab && (
        <div
          className={styles.pickerTabs}
          role="tablist"
          data-active-tab={tab}
          data-animate={animateTab || undefined}
          data-press-target={pressedTab}
        >
          <span
            className={styles.tabIndicator}
            data-testid="picker-tab-indicator"
            aria-hidden="true"
          />
          <button
            type="button"
            role="tab"
            aria-selected={tab === "emoji"}
            className={tab === "emoji" ? styles.activeTab : styles.inactiveTab}
            onPointerDown={(event) => {
              if (event.button === 0 && tab !== "emoji") {
                event.preventDefault();
                setPressedTab("emoji");
              }
            }}
            onPointerCancel={() => setPressedTab(undefined)}
            onPointerLeave={() => setPressedTab(undefined)}
            onClick={(event) => {
              if (tab === "emoji") return;
              setPressedTab(undefined);
              setAnimateTab(event.detail !== 0);
              setTab("emoji");
            }}
          >
            Emoji
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "gifs"}
            className={tab === "gifs" ? styles.activeTab : styles.inactiveTab}
            onPointerDown={(event) => {
              if (event.button === 0 && tab !== "gifs") {
                event.preventDefault();
                setPressedTab("gifs");
              }
            }}
            onPointerCancel={() => setPressedTab(undefined)}
            onPointerLeave={() => setPressedTab(undefined)}
            onClick={(event) => {
              if (tab === "gifs") return;
              setPressedTab(undefined);
              setAnimateTab(event.detail !== 0);
              setTab("gifs");
            }}
          >
            GIF
          </button>
        </div>
      )}
      {tab === "emoji" ? (
        <div ref={setHost} className={styles.emojiMart} />
      ) : (
        community && (
          <GifPicker
            community={community}
            initialQuery={search.current}
            onQueryChange={(value) => {
              search.current = value;
            }}
            select={(gif) => {
              onInsert.current(gifMarkdown(gif));
              setOpen(false);
              setAnimateTab(false);
              setPressedTab(undefined);
              setTab("emoji");
            }}
          />
        )
      )}
      {tab === "emoji" && error && (
        <div role="alert" className={styles.emojiStatus}>
          Could not load emoji picker: {error}
          <button type="button" onClick={() => retry(attempt + 1)}>
            Retry picker
          </button>
        </div>
      )}
      {tab === "emoji" && catalog.error && (
        <div className={styles.emojiStatus}>
          <p role="alert">{catalog.error}</p>
          <button type="button" onClick={() => void session.emoji.refresh()}>
            Retry emoji
          </button>
        </div>
      )}
    </section>
  );
  const button = (
    <button
      ref={trigger}
      className={reaction ? styles.reactionTrigger : undefined}
      type="button"
      aria-label={reaction ? "Add reaction" : "Insert emoji"}
      title={reaction ? "Add reaction" : "Insert emoji"}
      aria-expanded={open && !disabled}
      aria-busy={(gifDiscoveryRequested && gifs === undefined) || undefined}
      aria-controls={id}
      disabled={disabled}
      onPointerEnter={() => setGifDiscoveryRequested(true)}
      onFocus={() => setGifDiscoveryRequested(true)}
      onClick={() => {
        if (open) {
          setOpen(false);
          return;
        }
        setAnimateTab(false);
        setPressedTab(undefined);
        void session.emoji.ensure();
        if (gifs !== true && gifAvailability?.community === community)
          setGifAvailability(undefined);
        setGifDiscoveryRequested(true);
        setOpen(true);
      }}
    >
      {reaction ? (
        <SmilePlus size={18} aria-hidden="true" />
      ) : (
        <Smile size={20} aria-hidden="true" />
      )}
    </button>
  );
  const controlsView = (
    <fieldset
      ref={controls}
      disabled={disabled}
      aria-label="Emoji controls"
      className={styles.emojiPicker}
      onKeyDownCapture={(event) => {
        // Mart stops search key events before they bubble out of its shadow root.
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      {reaction ? <Popover.Trigger render={button} /> : button}
      {reaction ? (
        <Popover.Portal>
          <Popover.Positioner
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={16}
            className={styles.reactionPositioner}
          >
            <Popover.Popup render={picker} />
          </Popover.Positioner>
        </Popover.Portal>
      ) : open && !disabled ? (
        picker
      ) : null}
    </fieldset>
  );
  return reaction ? (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      {controlsView}
    </Popover.Root>
  ) : (
    controlsView
  );
}
