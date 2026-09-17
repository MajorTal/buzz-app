import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import type { ReactNode } from "react";
import { IconHome as House } from "@tabler/icons-react";
import { isTauri } from "@tauri-apps/api/core";
import type { RegisteredPage } from "../../features/pages/service";
import type { Communities } from "../../features/communities/service";
import { CommunitySwitcher } from "../../features/communities/CommunitySwitcher";
import { ProfileButton } from "./ProfileButton";
import { PageSearch } from "./PageSearch";
import { orderPages, pagePresentation } from "./presentation";
import { PanelFrame } from "../../features/panels/PanelFrame";

const macDesktop = isTauri() && /Mac/i.test(navigator.platform);

export function AppShell({
  pages,
  selected,
  onSelect,
  tone,
  workspace,
  communities,
  navigationControls,
  onCommunitySelect,
  launchers,
  companion,
  children,
}: {
  pages: readonly RegisteredPage[];
  selected: string;
  onSelect: (key: string) => void;
  tone: string;
  workspace?: boolean;
  communities: Communities;
  navigationControls?: ReactNode;
  onCommunitySelect?: (id: string | null) => void;
  launchers?: ReactNode;
  companion?: ReactNode;
  children: ReactNode;
}) {
  const fillsWorkspace = workspace || selected === "settings";
  return (
    <div
      data-shell-tone={tone}
      className="shell-background flex h-dvh min-h-0 flex-col overflow-hidden bg-shell text-ink"
    >
      {/* biome-ignore lint/a11y/useValidAnchor: A skip link navigates to a real fragment; enhance focus without replacing the app route hash. */}
      <a
        href="#main-content"
        onClick={(event) => {
          // Focus intent is not a navigation visit and must not replace the route hash.
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <header
        data-tauri-drag-region
        className={`shell-header ${macDesktop ? "shell-header-mac" : ""}`}
      >
        <div className="shell-communities" data-tauri-drag-region>
          {navigationControls}
          <CommunitySwitcher
            communities={communities}
            onSelect={onCommunitySelect}
          />
        </div>
        <nav aria-label="Pages" className="shell-pages">
          <NavigationItem
            type="button"
            variant="pill"
            aria-current={selected === "home" ? "page" : undefined}
            onClick={() => onSelect("home")}
            selected={selected === "home"}
            label="Home"
            icon={<House aria-hidden="true" size={15} stroke={1.7} />}
          />
          {orderPages(pages).map((page) => {
            const { label, icon: Icon } = pagePresentation(page);
            return (
              <NavigationItem
                type="button"
                key={page.key}
                variant="pill"
                aria-current={selected === page.key ? "page" : undefined}
                onClick={() => onSelect(page.key)}
                selected={selected === page.key}
                label={label}
                icon={<Icon aria-hidden="true" size={15} stroke={1.7} />}
              />
            );
          })}
        </nav>
        <div className="shell-actions" data-tauri-drag-region>
          {launchers}
          <PageSearch pages={pages} onSelect={onSelect} />
          <ProfileButton
            communities={communities}
            settingsSelected={selected === "settings"}
            onSettings={() => onSelect("settings")}
          />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main
          id="main-content"
          tabIndex={-1}
          className="min-h-0 min-w-0 flex-1 overflow-hidden px-2 pb-2 sm:px-4 sm:pb-4"
        >
          <PanelFrame companion={companion}>
            <div
              className={
                fillsWorkspace
                  ? "h-full min-h-0"
                  : "h-full min-h-0 overflow-y-auto px-2 pt-10 pb-8 sm:px-4 sm:pt-14 sm:pb-10"
              }
            >
              <div
                className={
                  fillsWorkspace ? "h-full min-h-0" : "mx-auto w-full max-w-4xl"
                }
              >
                {children}
              </div>
            </div>
          </PanelFrame>
        </main>
      </div>
    </div>
  );
}
