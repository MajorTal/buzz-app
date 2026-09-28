import { useEffect, useRef, type ReactNode } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { channelIcon } from "../../features/channels/channel-icon";
import { XIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./Channels.module.css";

export function ChannelSettingsPanel({
  channel,
  close,
  children,
  setupTools,
}: {
  channel: ChannelSummary | undefined;
  close(): void;
  children: ReactNode;
  setupTools?: ReactNode;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
  }, []);
  const ChannelIcon = channelIcon(channel);
  return (
    <Panel
      as="aside"
      aria-label="Channel settings"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className={styles.settingsPanel}>
        <PanelHeader
          title="Channel Settings"
          actions={
            <IconButton
              ref={closeButton}
              size="toolbar"
              aria-label="Close channel settings"
              onClick={close}
              icon={<XIcon size={18} aria-hidden="true" />}
            />
          }
        />
        <div className={styles.settingsContent}>
          {channel && (
            <>
              <div className={styles.settingsIdentity}>
                <span className={styles.settingsIcon}>
                  <ChannelIcon size={32} aria-hidden="true" />
                </span>
                <h3 className="text-heading text-primary">{channel.name}</h3>
              </div>
              <dl className={styles.settingsDetails}>
                {channel.channelType && (
                  <div>
                    <dt>Channel type</dt>
                    <dd>
                      {channel.channelType === "dm"
                        ? "Direct message"
                        : channel.channelType === "forum"
                          ? "Forum"
                          : channel.channelType === "session"
                            ? "Session"
                            : "Channel"}
                    </dd>
                  </div>
                )}
                {channel.members && (
                  <div>
                    <dt>Members</dt>
                    <dd>{channel.members.length}</dd>
                  </div>
                )}
                <div>
                  <dt>Channel ID</dt>
                  <dd className={styles.settingsId}>{channel.id}</dd>
                </div>
              </dl>
            </>
          )}
          {setupTools}
          <details className={styles.settingsDiagnostics}>
            <summary>Diagnostics</summary>
            <div className={styles.settingsTools}>{children}</div>
          </details>
        </div>
      </div>
    </Panel>
  );
}
