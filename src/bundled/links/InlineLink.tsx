import {
  IconBrandGithub,
  IconBrandGoogleDrive,
  IconBrandFigma,
  IconBrandNotion,
  IconBrandSlack,
  IconBrandDropbox,
  IconBrandOnedrive,
  IconBrandGitlab,
  IconBrandYoutube,
  IconBrandLoom,
  IconBrandZoom,
  IconBrandTeams,
  IconFileText,
  IconFileSpreadsheet,
  IconPresentation,
  IconWorld,
  IconMessageCircle,
  IconMessages,
  IconHash,
} from "@tabler/icons-react";
import { useContext, type ComponentProps } from "react";
import {
  LinkLabelContext,
  LinkContentContext,
} from "../../features/conversation/LinkLabelContext";
import { buzzLinkKind } from "../../features/navigation/buzz-links";
import styles from "../../shared/InlineReference.module.css";

// Match actual host boundaries, never a service name found in a path or query.
const serviceHosts = {
  github: ["github.com"],
  figma: ["figma.com"],
  notion: ["notion.so", "notion.site"],
  slack: ["slack.com"],
  dropbox: ["dropbox.com", "dropboxusercontent.com", "db.tt"],
  onedrive: ["onedrive.live.com", "1drv.ms"],
  gitlab: ["gitlab.com"],
  youtube: ["youtube.com", "youtu.be"],
  loom: ["loom.com"],
  zoom: ["zoom.us", "zoom.com"],
  teams: ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"],
} as const;

export function linkKind(href: string) {
  try {
    const url = new URL(href);
    if (url.protocol === "buzz:") {
      return buzzLinkKind(href);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Microsoft's OneDrive for Business host shape; ordinary SharePoint stays generic.
    if (/^[a-z0-9-]+-my\.sharepoint\.com$/.test(url.hostname))
      return "onedrive";
    if (url.hostname === "drive.google.com") return "drive";
    if (url.hostname === "docs.google.com") {
      const product = url.pathname.split("/")[1];
      if (product === "document") return "document";
      if (product === "spreadsheets") return "spreadsheet";
      if (product === "presentation") return "presentation";
      return "drive";
    }
    for (const kind of Object.keys(
      serviceHosts,
    ) as (keyof typeof serviceHosts)[]) {
      if (
        serviceHosts[kind].some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      )
        return kind;
    }
    return "web";
  } catch {
    return null;
  }
}

const icons = {
  web: IconWorld,
  github: IconBrandGithub,
  drive: IconBrandGoogleDrive,
  figma: IconBrandFigma,
  notion: IconBrandNotion,
  slack: IconBrandSlack,
  dropbox: IconBrandDropbox,
  onedrive: IconBrandOnedrive,
  gitlab: IconBrandGitlab,
  youtube: IconBrandYoutube,
  loom: IconBrandLoom,
  zoom: IconBrandZoom,
  teams: IconBrandTeams,
  document: IconFileText,
  spreadsheet: IconFileSpreadsheet,
  presentation: IconPresentation,
  buzz: IconMessageCircle,
  channel: IconHash,
  message: IconMessageCircle,
  thread: IconMessages,
};

/** Anchor wrapper for the isolated lab; messages use LinkLabel in a host-owned anchor. */
export function InlineLink({
  href,
  children,
  ...props
}: Omit<ComponentProps<"a">, "className" | "children"> & {
  href: string;
  children?: string;
}) {
  const kind = linkKind(href);
  if (!kind) return <>{children ?? href}</>;
  return (
    <a {...props} href={href} className={styles.link} data-kind={kind}>
      <LinkLabel href={href} label={children ?? href} />
    </a>
  );
}

export function LinkLabel({
  href,
  label = href,
}: {
  href: string;
  label?: string;
}) {
  const contextualLabel = useContext(LinkLabelContext);
  const content = useContext(LinkContentContext);
  const kind = linkKind(href);
  if (!kind) return <>{label}</>;
  if (label === href && contextualLabel) label = contextualLabel;
  if (label === href) {
    if (kind === "channel") label = "Channel";
    else if (kind === "message") label = "Message";
    else if (kind === "thread") label = "Thread";
    else if (kind === "buzz") label = "Buzz";
  }
  // The channel icon already supplies the visual hash.
  if (kind === "channel" && label.startsWith("#")) label = label.slice(1);
  // Markdown encodes Unicode in destinations while retaining it in visible text.
  const rawDestination =
    label === href ||
    (linkKind(label) !== null && new URL(label).href === new URL(href).href);
  const Icon = icons[kind];
  if (content !== undefined && !rawDestination)
    return (
      <span data-link-kind={kind}>
        <Icon aria-hidden="true" className={styles.icon} />
        {content}
      </span>
    );
  // Shorten only raw destinations; authored labels and resolved channel names stay intact.
  if (rawDestination) {
    const characters = Array.from(label);
    if (characters.length > 45) label = `${characters.slice(0, 44).join("")}…`;
  }
  // Keep the icon with the start of its label.
  const lead = (label.match(/^(?:https?:\/\/)?[^/\s]+/)?.[0] ?? label).slice(
    0,
    24,
  );
  return (
    <span data-link-kind={kind}>
      <span className={styles.lead}>
        <Icon aria-hidden="true" className={styles.icon} />
        {lead}
      </span>
      {label.slice(lead.length)}
    </span>
  );
}
