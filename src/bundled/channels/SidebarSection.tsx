import { FadingLabel } from "./FadingLabel";
import { useId, useState, type ReactNode, type Ref } from "react";
import {
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  ArrowsDownUpIcon,
  CaretDownIcon,
  DotsThreeIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { RelaySession } from "../../features/relay/session";
import { SidebarGroupIcon } from "./SidebarGroupIcon";
import styles from "./Channels.module.css";

export function SidebarSection({
  sectionKey,
  title,
  hideTitle = false,
  icon,
  session,
  open,
  onToggle,
  createChannel,
  newMessage,
  sort,
  dropRef,
  dropTarget = false,
  children,
}: {
  sectionKey: string;
  title: string;
  hideTitle?: boolean;
  icon?: string | undefined;
  session?: RelaySession | undefined;
  open: boolean;
  onToggle: (open: boolean) => void;
  createChannel?:
    | { available: boolean; open: (trigger: HTMLButtonElement) => void }
    | undefined;
  newMessage?: (() => void) | undefined;
  sort?:
    | {
        value: "alpha" | "recent";
        change: (mode: "alpha" | "recent") => void;
      }
    | undefined;
  dropRef?: Ref<HTMLDivElement> | undefined;
  dropTarget?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  if (hideTitle)
    return (
      <div className={`${styles.channelSection} ${styles.untitledSection}`}>
        <div
          id={id}
          className={`${styles.sectionContent} ${styles.untitledSectionContent}`}
        >
          <div>{children}</div>
        </div>
        <div className={styles.sectionActions}>
          {newMessage && (
            <IconButton
              size="compact"
              aria-label="New message"
              title="New message"
              onClick={newMessage}
              icon={<PlusIcon weight="bold" size={15} />}
            />
          )}
        </div>
      </div>
    );
  return (
    <div
      ref={dropRef}
      className={styles.channelSection}
      data-sidebar-section={sectionKey}
      data-drop-target={dropTarget || undefined}
    >
      <div className={styles.sectionHeader}>
        <details open={open}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: summary has native keyboard activation. */}
          <summary
            aria-label={title}
            aria-controls={id}
            onClick={(event) => {
              event.preventDefault();
              onToggle(!open);
            }}
          >
            <span className={styles.sectionLabel}>
              {icon && session && (
                <SidebarGroupIcon icon={icon} session={session} />
              )}
              <FadingLabel className={styles.sectionTitle}>{title}</FadingLabel>
            </span>
            <span className={`${styles.sidebarIcon} ${styles.sectionChevron}`}>
              <CaretDownIcon weight="bold" size={15} />
            </span>
          </summary>
        </details>
        <div className={styles.sectionActions}>
          <MenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              render={(props) => (
                <IconButton
                  {...props}
                  size="compact"
                  aria-label={`More actions for ${title}`}
                  icon={<DotsThreeIcon weight="bold" size={15} />}
                />
              )}
            />
            <MenuPopup align="end" aria-label={`More actions for ${title}`}>
              {sort && (
                <MenuSubmenu>
                  <MenuSubmenuTrigger>
                    <MenuIcon>
                      <ArrowsDownUpIcon size={14} />
                    </MenuIcon>
                    Sort
                  </MenuSubmenuTrigger>
                  <MenuSubmenuPopup
                    aria-label={`Sort ${title}`}
                    finalFocus={false}
                  >
                    <MenuRadioGroup
                      value={sort.value}
                      onValueChange={(mode) => {
                        sort.change(mode as "alpha" | "recent");
                        setMenuOpen(false);
                      }}
                    >
                      <MenuRadioItem closeOnClick={false} value="recent">
                        Recent
                      </MenuRadioItem>
                      <MenuRadioItem closeOnClick={false} value="alpha">
                        A–Z
                      </MenuRadioItem>
                    </MenuRadioGroup>
                  </MenuSubmenuPopup>
                </MenuSubmenu>
              )}
              <MenuItem
                onClick={() => {
                  onToggle(!open);
                  setMenuOpen(false);
                }}
              >
                {open ? "Collapse section" : "Expand section"}
              </MenuItem>
            </MenuPopup>
          </MenuRoot>
          {newMessage && (
            <IconButton
              size="compact"
              aria-label="New message"
              title="New message"
              onClick={newMessage}
              icon={<PlusIcon weight="bold" size={15} />}
            />
          )}
          {createChannel && (
            <IconButton
              size="compact"
              aria-label="Create channel"
              title={
                createChannel.available
                  ? "Create channel"
                  : "Channel creation unavailable"
              }
              disabled={!createChannel.available}
              onClick={(event) => createChannel.open(event.currentTarget)}
              icon={<PlusIcon weight="bold" size={15} />}
            />
          )}
        </div>
      </div>
      <div
        id={id}
        className={styles.sectionContent}
        inert={!open}
        hidden={!open}
      >
        <div>{children}</div>
      </div>
    </div>
  );
}
