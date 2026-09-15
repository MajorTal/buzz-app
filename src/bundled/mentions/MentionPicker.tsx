import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconAt as AtSign } from "@tabler/icons-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import styles from "./Mentions.module.css";

import type { ComposerToolProps } from "../../features/conversation/contracts";

/** Select identities from the shared relay roster, never from display-name matching. */
export function MentionPicker({
  session,
  channelId,
  disabled,
  select,
}: {
  session: RelaySession;
  channelId: string;
  disabled: boolean;
  select: ComposerToolProps["insertMention"];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const channel = list.channels.find((item) => item.id === channelId);
  const memberKey = channel?.members?.join(":") ?? "";
  useEffect(() => {
    if (!open || !memberKey) return;
    let current = true;
    void session.profiles
      .ensure(memberKey.split(":"), "background")
      .catch(() => {
        if (current)
          setError(
            "Names unavailable. Exact public keys still identify recipients.",
          );
      });
    return () => {
      current = false;
    };
  }, [session, open, memberKey]);
  const candidates = (channel?.members ?? [])
    .map((pubkey) => ({
      pubkey,
      name: profiles.get(pubkey)?.name ?? pubkey.slice(0, 12),
    }))
    .filter(({ name, pubkey }) =>
      `${name} ${pubkey}`.toLowerCase().includes(search.trim().toLowerCase()),
    );
  return (
    <fieldset
      disabled={disabled}
      className={styles.pickerControls}
      aria-label="Mention controls"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Mention a member"
        title="Mention a member"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          session.channels.ensureList();
        }}
      >
        <AtSign size={20} aria-hidden="true" />
      </button>
      {open && (
        <section
          id={id}
          className={styles.mentionPopover}
          aria-label="Mention a channel member"
        >
          <label>
            Search channel members
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
          </label>
          <p>Only members of this channel are shown.</p>
          {error && <p role="status">{error}</p>}
          {list.error && (
            <p role="alert">Could not refresh channel membership.</p>
          )}
          {!channel?.members && (
            <p role="status">Channel membership unavailable.</p>
          )}
          <button
            type="button"
            onClick={() => session.channels.refreshList?.()}
          >
            Refresh members
          </button>
          <div className={styles.mentionChoices}>
            {candidates.slice(0, 100).map((recipient) => (
              <button
                type="button"
                key={recipient.pubkey}
                aria-label={`${recipient.name} ${recipient.pubkey}`}
                disabled={!!channel?.archived}
                onClick={() => {
                  if (select(recipient)) setOpen(false);
                }}
              >
                <Avatar
                  alt=""
                  fallback={recipient.name}
                  src={session.media(
                    profiles.get(recipient.pubkey)?.picture ?? "",
                    "small",
                  )}
                  size="default"
                />
                <span className={styles.mentionLabel}>
                  <span>{recipient.name}</span>
                  <code title={recipient.pubkey}>{recipient.pubkey}</code>
                </span>
              </button>
            ))}
            {candidates.length > 100 && (
              <p>Narrow your search to see more members.</p>
            )}
            {channel?.members && !candidates.length && (
              <p>No matching channel members.</p>
            )}
          </div>
        </section>
      )}
    </fieldset>
  );
}
