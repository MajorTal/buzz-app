import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { IconSettings as Settings } from "@tabler/icons-react";
import type { Communities } from "../../features/communities/service";

export function ProfileButton({
  communities,
  settingsSelected,
  onSettings,
}: {
  communities: Communities;
  settingsSelected: boolean;
  onSettings(): void;
}) {
  const { profile } = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  return (
    <div ref={container} className="relative">
      <IconButton
        type="button"
        ref={trigger}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen((value) => !value);
        }}
        aria-label="Your profile"
        aria-expanded={open}
        aria-controls={id}
        title={profile.name || "Your profile"}
        variant="chrome"
        shape="round"
        icon={
          /* Keep pointer-origin Tab traversal rooted at the button in WebKit. */
          <span className="pointer-events-none flex size-full rounded-full">
            <Avatar
              src={
                profile.picture.startsWith("https://")
                  ? profile.picture
                  : undefined
              }
              alt=""
              fallback={profile.name || "?"}
              size="fill"
            />
          </span>
        }
      />
      <nav
        id={id}
        aria-label="Your account"
        hidden={!open}
        className="absolute top-full right-0 z-50 mt-2 w-56 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-surface p-2 shadow-surface"
      >
        <p className="m-0 truncate px-3 py-2 text-label-sm">
          {profile.name || "Your account"}
        </p>
        <button
          type="button"
          aria-current={settingsSelected ? "page" : undefined}
          className="flex w-full items-center gap-3 border-0 px-3 py-2 text-left aria-[current=page]:bg-soft"
          onClick={() => {
            setOpen(false);
            onSettings();
            document.getElementById("main-content")?.focus();
          }}
        >
          <Settings aria-hidden="true" size={17} />
          Settings
        </button>
      </nav>
    </div>
  );
}
