import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Button } from "../shared/design-system/ui/Button";
import { UnreadIndicatorSettings } from "./UnreadIndicatorSettings";
import { useSyncExternalStore } from "react";
import type { NotificationsService } from "../features/notifications/service";
import styles from "./NotificationSettings.module.css";

export function NotificationSettings({
  notifications,
  active = true,
}: {
  notifications: NotificationsService;
  active?: boolean;
}) {
  const state = useSyncExternalStore(
    notifications.subscribe,
    notifications.snapshot,
  );
  const { preferences, permission } = state;
  const desktopAlertsEnabled = !state.developmentPaused && preferences.enabled;
  const permissionStatus = state.developmentPaused
    ? "Notifications are paused by your local development setting. Remove BUZZ_DEV_NOTIFICATIONS=0 from .env.local and restart the dev server to resume normal behavior. Your saved alert choices are unchanged."
    : state.requesting
      ? "Waiting for system permission…"
      : permission === "denied"
        ? "Notifications are off. Turn them on in your browser or system settings."
        : permission === "unsupported"
          ? "This build can’t show system notifications."
          : permission === "default"
            ? "Allow notifications to receive alerts."
            : null;
  return (
    <section
      className={styles.root}
      aria-labelledby="notification-settings-title"
    >
      <Header
        id="notification-settings-title"
        title="Notifications"
        subtitle={
          state.systemManaged
            ? "Buzz sends alerts and badges for new activity in the selected community while it’s running. Manage app permissions and sounds in your system settings."
            : "Buzz sends alerts and badges for new activity in the selected community while it’s running. Manage app permissions in your system settings."
        }
      />
      <div className="grid grid-cols-1 gap-5">
        <div className={styles.preferenceList}>
          {state.categories.map(({ key, label }) => (
            <PreferenceRow
              key={key}
              label={label}
              checked={preferences.categories[key] !== false}
              onCheckedChange={(enabled) =>
                notifications.updatePreferences({
                  categories: { ...preferences.categories, [key]: enabled },
                })
              }
            />
          ))}
        </div>
        <PreferenceRow
          label="Desktop alerts"
          description="Show notifications for new activity. Opening an alert takes you to its message or thread."
          checked={desktopAlertsEnabled}
          disabled={state.developmentPaused}
          onCheckedChange={(enabled) =>
            notifications.updatePreferences({ enabled })
          }
        />
        {(permissionStatus ||
          (!state.systemManaged && !state.developmentPaused)) && (
          <div
            className={styles.permission}
            data-warning={
              state.developmentPaused ||
              permission === "denied" ||
              permission === "default" ||
              permission === "unsupported" ||
              undefined
            }
          >
            {permissionStatus && (
              <p role="status" className="text-body-sm">
                {permissionStatus}
              </p>
            )}
            {!state.systemManaged && !state.developmentPaused && (
              <div className={styles.actions}>
                {permission === "default" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    disabled={state.requesting}
                    onClick={() => void notifications.requestPermission()}
                  >
                    Allow notifications
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  disabled={state.requesting}
                  onClick={() => void notifications.refreshPermission()}
                >
                  Check permission
                </Button>
              </div>
            )}
          </div>
        )}
        <div className={styles.nestedPreferences}>
          <PreferenceRow
            label="Notify while viewing"
            description="Show alerts while the conversation is already open."
            checked={preferences.notifyWhileViewing}
            disabled={!desktopAlertsEnabled}
            onCheckedChange={(notifyWhileViewing) =>
              notifications.updatePreferences({ notifyWhileViewing })
            }
          />
          {!state.systemManaged && (
            <PreferenceRow
              label="Sound"
              description="Use the system notification sound."
              checked={preferences.sound}
              disabled={!desktopAlertsEnabled}
              onCheckedChange={(sound) =>
                notifications.updatePreferences({ sound })
              }
            />
          )}
        </div>
        <UnreadIndicatorSettings
          indicator={notifications.indicator}
          active={active}
        />
        {active && state.preferencesError && (
          <ToastNotice
            title="Notification choices weren’t saved"
            description={state.preferencesError}
          >
            <Button
              type="button"
              size="sm"
              onClick={() => notifications.updatePreferences({})}
            >
              Retry saving choices
            </Button>{" "}
            <Button
              type="button"
              size="sm"
              onClick={() => notifications.reloadPreferences()}
            >
              Reload saved choices
            </Button>
          </ToastNotice>
        )}
        {active && state.error && (
          <ToastNotice
            title="Buzz couldn’t send the notification"
            description={state.error}
          />
        )}
      </div>
    </section>
  );
}
