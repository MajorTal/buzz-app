import { Avatar } from "../../shared/Avatar";
import { AtSign, UserRoundPlus } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import type { AgentLibrary } from "../../features/agents/library";
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
  agents,
}: {
  session: RelaySession;
  channelId?: string;
  agents?: AgentLibrary["identities"];
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
  const memberKey = agents
    ? agents.map((agent) => agent.pubkey).join(":")
    : (channel?.members?.join(":") ?? "");
  const label = agents ? "Assign an agent" : "Mention a member";
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
  const candidates = (
    agents ? agents.map((agent) => agent.pubkey) : (channel?.members ?? [])
  )
    .map((pubkey) => ({
      pubkey,
      name:
        agents?.find((agent) => agent.pubkey === pubkey)?.name ??
        profiles.get(pubkey)?.name ??
        pubkey.slice(0, 12),
    }))
    .filter(({ name, pubkey }) =>
      `${name} ${pubkey}`.toLowerCase().includes(search.trim().toLowerCase()),
    );
  const button = (
    <button
      ref={trigger}
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={open}
      aria-controls={id}
      onClick={() => {
        if (!agents) {
          setOpen(!open);
          session.channels.ensureList();
        }
      }}
    >
      {agents ? (
        <UserRoundPlus size={20} aria-hidden="true" />
      ) : (
        <AtSign size={20} aria-hidden="true" />
      )}
    </button>
  );
  const picker = (
    <section
      id={id}
      className={styles.mentionPopover}
      style={
        agents
          ? {
              position: "relative",
              bottom: "auto",
              maxHeight: "min(360px, var(--available-height))",
            }
          : undefined
      }
      aria-label={agents ? "Choose an assignee" : "Mention a channel member"}
    >
      <label>
        {agents ? "Search your agents" : "Search channel members"}
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </label>
      <p>
        {agents
          ? "Agents from your Buzz library. Assignment does not send a mention."
          : "Only members of this channel are shown."}
      </p>
      {error && <p role="status">{error}</p>}
      {!agents && list.error && (
        <p role="alert">Could not refresh channel membership.</p>
      )}
      {!agents && !channel?.members && (
        <p role="status">Channel membership unavailable.</p>
      )}
      {!agents && (
        <button type="button" onClick={() => session.channels.refreshList?.()}>
          Refresh members
        </button>
      )}
      <div className={styles.mentionChoices}>
        {candidates.slice(0, 100).map((recipient) => (
          <button
            type="button"
            key={recipient.pubkey}
            aria-label={`${recipient.name} ${recipient.pubkey}`}
            disabled={!agents && !!channel?.archived}
            onClick={() => {
              if (select(recipient)) setOpen(false);
            }}
          >
            <Avatar
              name={recipient.name}
              src={session.media(
                profiles.get(recipient.pubkey)?.picture ??
                  agents?.find((agent) => agent.pubkey === recipient.pubkey)
                    ?.avatar ??
                  "",
              )}
              className="size-8 rounded-lg text-xs"
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
        {(agents || channel?.members) && !candidates.length && (
          <p>
            {agents ? "No matching agents." : "No matching channel members."}
          </p>
        )}
      </div>
    </section>
  );
  const controls = (
    <fieldset
      disabled={disabled}
      className={styles.pickerControls}
      aria-label={agents ? "Assignment controls" : "Mention controls"}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      {agents ? <Popover.Trigger render={button} /> : button}
      {agents ? (
        <Popover.Portal>
          <Popover.Positioner
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            style={{ zIndex: 1000 }}
          >
            <Popover.Popup render={picker} />
          </Popover.Positioner>
        </Popover.Portal>
      ) : (
        open && picker
      )}
    </fieldset>
  );
  return agents ? (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {controls}
    </Popover.Root>
  ) : (
    controls
  );
}
