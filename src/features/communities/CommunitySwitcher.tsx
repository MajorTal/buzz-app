import { Dialog } from "../../shared/design-system/ui/Dialog";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IconChevronDown as ChevronDown,
  IconWorld as Globe2,
  IconPlus as Plus,
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
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement>(null);
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
    setOpen(false);
  };
  return (
    <>
      <NavigationItem
        ref={trigger}
        variant="pill"
        aria-label="Switch community"
        title={current?.name ?? "Personal space"}
        label={current?.name ?? "Personal space"}
        icon={<Globe2 size={18} aria-hidden="true" />}
        trailing={<ChevronDown size={14} aria-hidden="true" />}
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Communities"
        closeLabel="Close communities"
        finalFocus={joining ? false : trigger}
      >
        <nav className={styles.communityList} aria-label="Communities">
          <NavigationItem
            type="button"
            title="Personal space"
            aria-label="Personal space"
            aria-current={client.selected === null ? "true" : undefined}
            onClick={() => select(null)}
            selected={client.selected === null}
            label="Personal space"
            icon={<Globe2 size={22} aria-hidden="true" />}
          />
          {client.memberships.map((m) => (
            <NavigationItem
              type="button"
              key={m.id}
              title={m.name}
              aria-label={`Switch to ${m.name}`}
              aria-current={client.selected === m.id ? "true" : undefined}
              onClick={() => select(m.id)}
              selected={client.selected === m.id}
              label={m.name}
              icon={
                <span className={styles.communityIcon}>
                  <CommunityIcon
                    name={m.name}
                    {...(m.icon ? { icon: m.icon } : {})}
                  />
                </span>
              }
            />
          ))}
          <NavigationItem
            type="button"
            title="Add a community"
            aria-label="Add a community"
            onClick={() => {
              setOpen(false);
              setJoining(true);
            }}
            label="Add a community"
            icon={<Plus size={22} aria-hidden="true" />}
          />
        </nav>
      </Dialog>
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
