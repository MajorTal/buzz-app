import { Switch } from "../shared/design-system/ui/Switch";
import { Button } from "../shared/design-system/ui/Button";
import { useSyncExternalStore } from "react";
import type { NotificationsService } from "../features/notifications/service";
import styles from "./NotificationSettings.module.css";

export function NotificationSettings({
  notifications,
}: {
  notifications: NotificationsService;
}) {
  const state = useSyncExternalStore(
    notifications.subscribe,
    notifications.snapshot,
  );
  const { preferences, permission } = state;
  return (
    <section
      className={styles.root}
      aria-labelledby="notification-settings-title"
    >
      <h2 id="notification-settings-title" className="mt-0 mb-6 text-label">
        Notifications
      </h2>
      <div className="grid gap-5">
        <p className="text-body-sm text-muted">
          Choices are saved for this account on this device. System permission
          is separate.
        </p>
        <Switch
          label="Desktop alerts"
          checked={preferences.enabled}
          onCheckedChange={(enabled) =>
            notifications.updatePreferences({ enabled })
          }
        />
        <p role="status" className="text-body-sm text-muted">
          {state.requesting
            ? "Waiting for system permission…"
            : permission === "granted"
              ? "Permission granted. Your alert choices still apply."
              : permission === "denied"
                ? "Blocked. Allow notifications in your browser or system settings."
                : permission === "unsupported"
                  ? "System notifications are unavailable in this build."
                  : permission === "unknown"
                    ? "Permission is controlled by system notification settings."
                    : "Allow notifications to receive alerts."}
        </p>
        {!state.systemManaged && (
          <div className={styles.actions}>
            {permission === "default" && (
              <Button
                type="button"
                disabled={state.requesting}
                onClick={() => void notifications.requestPermission()}
              >
                Allow notifications
              </Button>
            )}
            <Button
              type="button"
              disabled={state.requesting}
              onClick={() => void notifications.refreshPermission()}
            >
              Check permission
            </Button>
          </div>
        )}
        <Switch
          label="Notify while viewing"
          checked={preferences.notifyWhileViewing}
          onCheckedChange={(notifyWhileViewing) =>
            notifications.updatePreferences({ notifyWhileViewing })
          }
        />
        {state.systemManaged ? (
          <p className="text-body-sm text-muted">
            Manage sound and permission in system notification settings. Desktop
            clicks bring Buzz forward and open the message or thread while Buzz
            is running.
          </p>
        ) : (
          <>
            <Switch
              label="Sound"
              checked={preferences.sound}
              onCheckedChange={(sound) =>
                notifications.updatePreferences({ sound })
              }
            />
            <p className="text-body-sm text-muted">
              Sound uses the system default where supported. Turning it off
              keeps alerts enabled.
            </p>
          </>
        )}
        <fieldset className="m-0 grid gap-3 border-0 p-0">
          <legend className="mb-3 font-medium">Notify me about</legend>
          {state.categories.map(({ key, label }) => (
            <Switch
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
        </fieldset>
        <p className="text-body-sm text-muted">
          Message alerts cover the selected community while Buzz is running.
          Reading history and reconnecting stay quiet.
        </p>
        {state.preferencesError && (
          <div role="alert" className="notice">
            <p>{state.preferencesError}</p>
            <Button
              type="button"
              onClick={() => notifications.updatePreferences({})}
            >
              Retry saving choices
            </Button>{" "}
            <Button
              type="button"
              onClick={() => notifications.reloadPreferences()}
            >
              Reload saved choices
            </Button>
          </div>
        )}
        {state.error && (
          <p role="alert" className="notice">
            {state.error}
          </p>
        )}
      </div>
    </section>
  );
}
