import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IconChevronDown as ChevronDown,
  IconWorld as Globe2,
  IconPlus as Plus,
  IconX as X,
} from "@tabler/icons-react";
import { CommunityDialog } from "./CommunityDialog";
import type { Communities } from "./service";
import styles from "./Communities.module.css";
function CommunityIcon({ icon, name }: { icon?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return icon && !failed ? (
    <img
      src={icon}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span>{name.slice(0, 2).toUpperCase()}</span>
  );
}
export function CommunitySwitcher({
  communities,
  onSelect,
}: {
  communities: Communities;
  onSelect?: ((id: string | null) => void) | undefined;
}) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const [joining, setJoining] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasJoining = useRef(false);
  useEffect(() => {
    // Restore only after the child modal unmounts and releases its focus trap.
    if (wasJoining.current && !joining) trigger.current?.focus();
    wasJoining.current = joining;
  }, [joining]);
  const current = client.memberships.find((m) => m.id === client.selected);
  const select = (id: string | null) => {
    if (onSelect) onSelect(id);
    else communities.select(id);
    dialog.current?.close();
  };
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={styles.switcher}
        aria-label="Switch community"
        title={current?.name ?? "Personal space"}
        onClick={(event) => {
          // Safari does not focus pointer-clicked buttons. Remember this trigger
          // before opening so native dialog dismissal restores keyboard focus.
          event.currentTarget.focus();
          dialog.current?.showModal();
        }}
      >
        <Globe2 size={18} aria-hidden="true" />
        <span>{current?.name ?? "Personal space"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <dialog ref={dialog} className={styles.dialog} aria-label="Communities">
        <header>
          <h2>Communities</h2>
          <button
            type="button"
            aria-label="Close communities"
            onClick={() => dialog.current?.close()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <nav className={styles.communityList} aria-label="Communities">
          <button
            type="button"
            title="Personal space"
            aria-label="Personal space"
            aria-current={client.selected === null ? "true" : undefined}
            onClick={() => select(null)}
          >
            <Globe2 size={22} aria-hidden="true" />
            <span>Personal space</span>
          </button>
          {client.memberships.map((m) => (
            <button
              type="button"
              key={m.id}
              title={m.name}
              aria-label={`Switch to ${m.name}`}
              aria-current={client.selected === m.id ? "true" : undefined}
              onClick={() => select(m.id)}
            >
              <span className={styles.communityIcon}>
                <CommunityIcon
                  name={m.name}
                  {...(m.icon ? { icon: m.icon } : {})}
                />
              </span>
              <span>{m.name}</span>
            </button>
          ))}
          <button
            type="button"
            title="Add a community"
            aria-label="Add a community"
            onClick={() => {
              dialog.current?.close();
              setJoining(true);
            }}
          >
            <Plus size={22} aria-hidden="true" />
            <span>Add a community</span>
          </button>
        </nav>
      </dialog>
      {joining && (
        <CommunityDialog
          communities={communities}
          mode="join"
          onJoined={select}
          close={() => setJoining(false)}
        />
      )}
    </>
  );
}
