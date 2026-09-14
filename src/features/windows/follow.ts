import { communityDestination } from "../communities/destination";

/**
 * Detached windows have no community switcher; they follow the selection the
 * main window saves. Reports the canonical community id, or null for Personal
 * space, each time the saved client preferences for `viewer` change.
 */
export function followSavedCommunity(
  viewer: string,
  onChange: (selected: string | null) => void,
  host: Pick<Window, "addEventListener" | "removeEventListener"> &
    Pick<Window, "localStorage"> = window,
): () => void {
  const key = `buzz-client.v1:${viewer}`;
  const changed = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return;
    let selected: string | null;
    try {
      const raw: unknown = JSON.parse(host.localStorage.getItem(key) ?? "null");
      const saved =
        raw && typeof raw === "object" && "selected" in raw
          ? raw.selected
          : null;
      if (saved !== null && typeof saved !== "string") return;
      selected = saved ? communityDestination(saved).id : null;
    } catch {
      return; // Unreadable preferences are the main window's problem to report.
    }
    onChange(selected);
  };
  host.addEventListener("storage", changed);
  return () => host.removeEventListener("storage", changed);
}
