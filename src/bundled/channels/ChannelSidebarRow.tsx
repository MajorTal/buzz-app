import { FadingLabel } from "./FadingLabel";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  CaretDownIcon,
  CaretRightIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { useId, type ReactElement, type ReactNode } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import styles from "./ChannelSidebarRow.module.css";

export function ChannelSidebarRow({
  channel,
  icon,
  nameAccessory,
  badge,
  childContent,
  dmVisualSpacing = false,
  wrapSelect,
  selected,
  presenceDescription,
  sessions,
  draft,
  draftSelected,
  collapsed,
  onToggle,
  onSelect,
  onPrepare,
  onNewSession,
  onHideDm,
}: {
  channel: ChannelSummary;
  icon: ReactNode;
  nameAccessory?: ReactNode;
  badge?: ReactNode;
  childContent?: ((channel: ChannelSummary) => ReactNode) | undefined;
  dmVisualSpacing?: boolean;
  wrapSelect?: ((trigger: ReactElement) => ReactNode) | undefined;
  selected?: string | undefined;
  presenceDescription?: string | undefined;
  sessions: readonly ChannelSummary[];
  draft: boolean;
  draftSelected: boolean;
  collapsed: boolean;
  onToggle: (open: boolean) => void;
  onSelect: (id: string) => void;
  onPrepare: (id: string) => void;
  onNewSession: (id: string) => void;
  onHideDm?: (id: string) => void;
}) {
  const childrenId = useId();
  const presenceId = `${childrenId}-presence`;
  const hasChildren = draft || sessions.length > 0;
  const Chevron = collapsed ? CaretRightIcon : CaretDownIcon;
  const selectButton = (
    <NavigationItem
      type="button"
      data-channel-id={channel.id}
      aria-current={
        selected === channel.id && !draftSelected ? "page" : undefined
      }
      aria-describedby={presenceDescription ? presenceId : undefined}
      onPointerEnter={() => onPrepare(channel.id)}
      onFocus={() => onPrepare(channel.id)}
      onClick={() => onSelect(channel.id)}
      selected={selected === channel.id && !draftSelected}
      label={
        <span
          className={styles.nameContent}
          data-name-accessory={nameAccessory ? "" : undefined}
        >
          <FadingLabel className={styles.label}>{channel.name}</FadingLabel>
          {nameAccessory}
        </span>
      }
      icon={
        hasChildren ? (
          <span className={styles.iconSpace} aria-hidden="true" />
        ) : (
          <span
            className={styles.iconSpace}
            data-dm-visual={dmVisualSpacing || undefined}
          >
            {icon}
          </span>
        )
      }
      trailing={badge && <span className={styles.badges}>{badge}</span>}
    />
  );
  return (
    <>
      <div
        className={styles.row}
        data-channel-sidebar-row=""
        data-selected={(selected === channel.id && !draftSelected) || undefined}
      >
        {hasChildren && (
          <span className={styles.disclosure}>
            <IconButton
              type="button"
              size="compact"
              aria-label={`${collapsed ? "Expand" : "Collapse"} sessions in ${channel.name}`}
              aria-expanded={!collapsed}
              aria-controls={childrenId}
              onClick={() => onToggle(collapsed)}
              icon={
                <>
                  <span className={styles.hashIcon} aria-hidden="true">
                    {icon}
                  </span>
                  <Chevron
                    className={styles.chevronIcon}
                    size={17}
                    aria-hidden="true"
                  />
                </>
              }
            />
          </span>
        )}
        <div className={styles.select}>
          {wrapSelect ? wrapSelect(selectButton) : selectButton}
          {presenceDescription && (
            <span className="sr-only" id={presenceId}>
              {presenceDescription}
            </span>
          )}
        </div>
        {channel.channelType === "dm" && onHideDm && (
          <span className={`${styles.more} ${styles.remove}`}>
            <IconButton
              type="button"
              size="compact"
              shape="round"
              aria-label={`Remove ${channel.name} from DMs`}
              onClick={(event) => {
                const section = event.currentTarget.closest(
                  "[data-sidebar-section]",
                );
                const rows = [
                  ...(section?.querySelectorAll<HTMLElement>(
                    "button[data-channel-id]",
                  ) ?? []),
                ];
                const index = rows.findIndex(
                  (row) => row.dataset.channelId === channel.id,
                );
                const otherSection = [
                  ...(section?.parentElement?.querySelectorAll<HTMLElement>(
                    "details > summary",
                  ) ?? []),
                ].find((summary) => summary.parentElement !== section);
                (rows[index + 1] ?? rows[index - 1] ?? otherSection)?.focus();
                onHideDm(channel.id);
              }}
              icon={<XIcon size={15} aria-hidden="true" />}
            />
          </span>
        )}
      </div>
      <div className={styles.sessions} id={childrenId} hidden={collapsed}>
        {draft && (
          <NavigationItem
            icon={<span className={styles.iconSpace} aria-hidden="true" />}
            label="New session"
            trailing={<small>Draft</small>}
            aria-label={`New session draft in ${channel.name}`}
            selected={draftSelected}
            onClick={() => onNewSession(channel.id)}
          />
        )}
        {sessions.map((child) => (
          <NavigationItem
            key={child.id}
            type="button"
            icon={<span className={styles.iconSpace} aria-hidden="true" />}
            data-channel-id={child.id}
            aria-label={`${child.name}, session in ${channel.name}`}
            aria-current={selected === child.id ? "page" : undefined}
            onPointerEnter={() => onPrepare(child.id)}
            onFocus={() => onPrepare(child.id)}
            onClick={() => onSelect(child.id)}
            selected={selected === child.id}
            label={
              <FadingLabel className={styles.childLabel}>
                {childContent?.(child) ?? child.name}
              </FadingLabel>
            }
          />
        ))}
      </div>
    </>
  );
}
