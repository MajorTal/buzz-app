import { useSyncExternalStore } from "react";
import type { NotificationsService } from "../features/notifications/service";

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
    <section aria-labelledby="notification-settings-title">
      <h2 id="notification-settings-title" className="mt-0 mb-6 text-label">
        Notifications
      </h2>
      <div className="space-y-5">
        <p className="text-body-sm text-muted">
          Choices are saved for this account on this device. System permission
          is separate.
        </p>
        <Toggle
          label="Desktop alerts"
          checked={preferences.enabled}
          onChange={(enabled) => notifications.updatePreferences({ enabled })}
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
          <div className="flex gap-2">
            {permission === "default" && (
              <button
                type="button"
                disabled={state.requesting}
                onClick={() => void notifications.requestPermission()}
              >
                Allow notifications
              </button>
            )}
            <button
              type="button"
              disabled={state.requesting}
              onClick={() => void notifications.refreshPermission()}
            >
              Check permission
            </button>
          </div>
        )}
        <Toggle
          label="Notify while viewing"
          checked={preferences.notifyWhileViewing}
          onChange={(notifyWhileViewing) =>
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
            <Toggle
              label="Sound"
              checked={preferences.sound}
              onChange={(sound) => notifications.updatePreferences({ sound })}
            />
            <p className="text-body-sm text-muted">
              Sound uses the system default where supported. Turning it off
              keeps alerts enabled.
            </p>
          </>
        )}
        <fieldset className="m-0 space-y-3 border-0 p-0">
          <legend className="mb-3 font-medium">Notify me about</legend>
          {state.categories.map(({ key, label }) => (
            <Toggle
              key={key}
              label={label}
              checked={preferences.categories[key] !== false}
              onChange={(enabled) =>
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
            <button
              type="button"
              onClick={() => notifications.updatePreferences({})}
            >
              Retry saving choices
            </button>{" "}
            <button
              type="button"
              onClick={() => notifications.reloadPreferences()}
            >
              Reload saved choices
            </button>
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
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
