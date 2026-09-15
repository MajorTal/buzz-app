import {
  IconAppWindow as AppWindow,
  IconHome as House,
  IconMessages as MessagesSquare,
  IconAdjustments as Settings2,
} from "@tabler/icons-react";
import type { RegisteredPage } from "../../features/pages/service";

// Shell-owned presentation keeps plugin content independent of navigation chrome.
// Add page identities here; unknown plugins inherit a consistent layout default.
export const shellPresentation = {
  home: { label: "Home", icon: House, tone: "sky" },
  settings: { label: "Settings", icon: Settings2, tone: "lavender" },
  channels: { label: "Messages", icon: MessagesSquare, tone: "lime" },
} as const;

// Navigation order is host policy, never plugin activation timing. Match full
// contribution keys so an external page's local ID cannot claim a bundled slot.
export function orderPages(pages: readonly RegisteredPage[]) {
  const rank = (page: RegisteredPage) => {
    if (page.key === "buzz.channels/channels") return 0;
    if (page.key === "buzz.projects/projects") return 1;
    return 2;
  };
  return [...pages].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      pagePresentation(a).label.localeCompare(
        pagePresentation(b).label,
        "en",
      ) ||
      a.key.localeCompare(b.key, "en"),
  );
}

export function pagePresentation(page: RegisteredPage) {
  if (page.id === "channels") return shellPresentation.channels;
  return {
    label: page.title,
    icon: AppWindow,
    tone: page.layout === "workspace" ? "lime" : "sky",
  };
}
