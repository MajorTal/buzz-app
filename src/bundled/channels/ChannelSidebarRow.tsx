import { useId, useRef, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronDown, ChevronRight, MoreVertical } from "lucide-react";
import type { ChannelSummary } from "../../features/relay/contracts";
import completion from "../../features/conversation/Completions.module.css";
import styles from "./ChannelSidebarRow.module.css";

export function ChannelSidebarRow({
  channel,
  icon,
  badge,
  selected,
  sessions,
  draft,
  draftSelected,
  collapsed,
  onToggle,
  onSelect,
  onPrepare,
  onNewSession,
}: {
  channel: ChannelSummary;
  icon: ReactNode;
  badge?: ReactNode;
  selected?: string | undefined;
  sessions: readonly ChannelSummary[];
  draft: boolean;
  draftSelected: boolean;
  collapsed: boolean;
  onToggle: (open: boolean) => void;
  onSelect: (id: string) => void;
  onPrepare: (id: string) => void;
  onNewSession: (id: string) => void;
}) {
  const starting = useRef(false);
  const childrenId = useId();
  const hasChildren = draft || sessions.length > 0;
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const canParent =
    channel.channelType !== "dm" &&
    channel.channelType !== "session" &&
    !channel.archived;
  return (
    <>
      <div
        className={styles.row}
        data-selected={(selected === channel.id && !draftSelected) || undefined}
      >
        {hasChildren && (
          <button
            type="button"
            className={styles.disclosure}
            aria-label={`${collapsed ? "Expand" : "Collapse"} sessions in ${channel.name}`}
            aria-expanded={!collapsed}
            aria-controls={childrenId}
            onClick={() => onToggle(collapsed)}
          >
            <span className={styles.hashIcon} aria-hidden="true">
              {icon}
            </span>
            <Chevron
              className={styles.chevronIcon}
              size={17}
              aria-hidden="true"
            />
          </button>
        )}
        <button
          className={styles.select}
          type="button"
          title={channel.name}
          data-channel-id={channel.id}
          aria-current={
            selected === channel.id && !draftSelected ? "page" : undefined
          }
          onPointerEnter={() => onPrepare(channel.id)}
          onFocus={() => onPrepare(channel.id)}
          onClick={() => onSelect(channel.id)}
        >
          {hasChildren ? (
            <span className={styles.iconSpace} aria-hidden="true" />
          ) : (
            icon
          )}
          <span>{channel.name}</span>
          {badge}
        </button>
        {canParent && (
          <Menu.Root
            onOpenChange={(open) => {
              if (open) starting.current = false;
            }}
          >
            <Menu.Trigger
              className={styles.more}
              aria-label={`More options for ${channel.name}`}
            >
              <MoreVertical size={15} />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                side="bottom"
                align="end"
                sideOffset={4}
                className={styles.positioner}
              >
                <Menu.Popup
                  className={`${completion.popup} ${styles.menu}`}
                  data-compact=""
                  finalFocus={() =>
                    starting.current
                      ? (document
                          .getElementById("new-session-prompt")
                          ?.querySelector<HTMLElement>('[role="textbox"]') ??
                        false)
                      : true
                  }
                  aria-label={`${channel.name} options`}
                >
                  <Menu.Item
                    className={`${completion.option} ${styles.menuItem}`}
                    onClick={() => {
                      starting.current = true;
                      onNewSession(channel.id);
                    }}
                  >
                    New session
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        )}
      </div>
      <div id={childrenId} hidden={collapsed}>
        {draft && (
          <button
            type="button"
            className={styles.child}
            aria-label={`New session draft in ${channel.name}`}
            aria-current={draftSelected ? "page" : undefined}
            onClick={() => onNewSession(channel.id)}
          >
            <span className={styles.iconSpace} aria-hidden="true" />
            <span>New session</span>
            <small>Draft</small>
          </button>
        )}
        {sessions.map((child) => (
          <button
            key={child.id}
            type="button"
            className={styles.child}
            title={child.name}
            data-channel-id={child.id}
            aria-label={`${child.name}, session in ${channel.name}`}
            aria-current={selected === child.id ? "page" : undefined}
            onPointerEnter={() => onPrepare(child.id)}
            onFocus={() => onPrepare(child.id)}
            onClick={() => onSelect(child.id)}
          >
            <span className={styles.iconSpace} aria-hidden="true" />
            <span>{child.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}
