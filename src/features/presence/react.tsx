import { useCallback, useSyncExternalStore } from "react";
import type { Presence } from "./presence";
/** Text and distinct symbols keep presence readable without color perception. */
export function PresenceIndicator({
  presence,
  pubkey,
  profile = false,
}: {
  presence: Presence;
  pubkey: string;
  profile?: boolean;
}) {
  const subscribe = useCallback(
    (listener: () => void) => presence.subscribe(pubkey, listener, profile),
    [presence, pubkey, profile],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => `${presence.status(pubkey)}:${presence.limited(pubkey)}`,
  );
  const status = state.split(":")[0] as ReturnType<Presence["status"]>;
  const labels = {
    online: "● Online",
    away: "◐ Away",
    offline: "○ Offline",
    unknown: "? Unknown",
  };
  return (
    <span
      role="img"
      className="text-body-sm text-secondary"
      aria-label={`Presence: ${status}`}
      title={
        presence.limited(pubkey)
          ? "Presence demand limit reached"
          : "Periodically refreshed community presence"
      }
    >
      {labels[status]}
    </span>
  );
}
