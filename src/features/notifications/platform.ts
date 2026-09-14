import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export type NotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "unknown";
export type NotificationPresentation = Readonly<{
  id: string;
  title: string;
  body: string;
  silent: boolean;
}>;
export interface NotificationPlatform {
  readonly label: string;
  readonly systemManaged?: boolean;
  permission(): Promise<NotificationPermissionState>;
  requestPermission(): Promise<NotificationPermissionState>;
  show(
    item: NotificationPresentation,
    activate: () => void,
    failed: (error: Error) => void,
  ): Promise<void>;
  dispose(): void;
}

type DesktopResponse = Readonly<{
  id: string;
  kind: "activated" | "closed" | "failed";
  error?: string;
}>;

/** One native presentation owner, with its callback registered before sending. */
export function createNotifications(): NotificationPlatform {
  if (!isTauri()) return createBrowserNotifications();
  let disposed = false;
  const active = new Map<string, Channel<DesktopResponse>>();
  const release = (id: string, channel: Channel<DesktopResponse>) => {
    channel.onmessage = () => {};
    active.delete(id);
  };
  return {
    label: "Desktop notifications",
    systemManaged: true,
    // The native backends do not expose an OS permission check or prompt.
    permission: async () => "unknown",
    requestPermission: async () => "unknown",
    async show(item, activate, failed) {
      if (disposed) throw new Error("Desktop notifications have stopped");
      // Reject before sending instead of stranding an older alert's target.
      if (active.size >= 128)
        throw new Error("Too many active desktop notifications (maximum 128)");
      const channel = new Channel<DesktopResponse>((response) => {
        if (disposed || response.id !== item.id || !active.has(item.id)) return;
        release(item.id, channel);
        if (response.error) failed(new Error(response.error));
        if (response.kind === "activated") activate();
      });
      active.set(item.id, channel);
      try {
        // Native code restores/focuses the main window before returning the click.
        // No destination or account data crosses this boundary.
        await invoke("notification_show", {
          id: item.id,
          title: item.title,
          body: item.body,
          onEvent: channel,
        });
      } catch (error) {
        release(item.id, channel);
        throw error;
      }
    },
    dispose() {
      disposed = true;
      for (const [id, channel] of active) release(id, channel);
    },
  };
}

/** Running-tab alerts. Native delivery never falls back to a WebView API. */
export function createBrowserNotifications(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
): NotificationPlatform {
  const api =
    host && !isTauri() && "Notification" in host
      ? (host as Window & { Notification: typeof Notification }).Notification
      : undefined;
  const active = new Map<string, Notification>();
  function release(id: string, notification: Notification) {
    notification.onclick = null;
    notification.onclose = null;
    notification.onerror = null;
    active.delete(id);
  }
  function retire(id: string, notification: Notification) {
    release(id, notification);
    notification.close();
  }
  return {
    label: isTauri()
      ? "Native notifications unavailable in this build"
      : "Browser notifications",
    permission: async () => api?.permission ?? "unsupported",
    requestPermission: () =>
      api ? api.requestPermission() : Promise.resolve("unsupported"),
    async show(item, activate, failed) {
      if (api?.permission !== "granted")
        throw new Error("Notification permission is not granted");
      // Closing the oldest presentation also retires its callback; never strand
      // an open banner by independently evicting its only navigation target.
      if (active.size >= 128) {
        const first = active.entries().next().value;
        if (first) retire(...first);
      }
      const notification = new api(item.title, {
        body: item.body,
        tag: item.id,
        silent: item.silent,
      });
      active.set(item.id, notification);
      notification.onclick = () => {
        host?.focus();
        activate();
        retire(item.id, notification);
      };
      notification.onclose = () => release(item.id, notification);
      notification.onerror = () => {
        retire(item.id, notification);
        failed(new Error("The browser could not display a notification."));
      };
    },
    dispose() {
      for (const [id, item] of active) retire(id, item);
    },
  };
}
