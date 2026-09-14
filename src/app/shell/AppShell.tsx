import { type ReactNode, useSyncExternalStore } from "react";
import { House } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import type { RegisteredPage } from "../../features/pages/service";
import type { RegisteredPanel } from "../../features/panels/service";
import type { Communities } from "../../features/communities/service";
import { type WindowHost, panelTabKey } from "../../features/windows/service";
import { CommunitySwitcher } from "../../features/communities/CommunitySwitcher";
import { ProfileButton } from "./ProfileButton";
import { PageSearch } from "./PageSearch";
import { PageTab } from "./PageTab";
import { LauncherIcon } from "./PanelLaunchers";
import { orderPages, pagePresentation } from "./presentation";
import { PanelFrame } from "../../features/panels/PanelFrame";

const macDesktop = isTauri() && /Mac/i.test(navigator.platform);

export function AppShell({
  pages,
  panelTabs = [],
  selected,
  onSelect,
  tone,
  workspace,
  communities,
  windows,
  navigationControls,
  onCommunitySelect,
  launchers,
  companion,
  children,
}: {
  pages: readonly RegisteredPage[];
  /** Launcher panels shown as tabs (detached windows only). */
  panelTabs?: readonly RegisteredPanel[];
  selected: string;
  onSelect: (key: string) => void;
  tone: string;
  workspace?: boolean;
  communities: Communities;
  windows: WindowHost;
  navigationControls?: ReactNode;
  onCommunitySelect?: (id: string | null) => void;
  launchers?: ReactNode;
  companion?: ReactNode;
  children: ReactNode;
}) {
  const layout = useSyncExternalStore(windows.subscribe, windows.snapshot);
  // Detached windows carry only the tab strip; community, Settings and profile stay in main.
  const main = windows.isMain;
  const ordered = orderPages(pages);
  const tabsHere = ordered.length + panelTabs.length;
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
          {main && (
            <CommunitySwitcher
              communities={communities}
              onSelect={onCommunitySelect}
            />
          )}
        </div>
        <nav
          aria-label="Pages"
          className="shell-pages"
          data-drop-target={layout.dropTarget || undefined}
        >
          {main && (
            <button
              type="button"
              className="shell-tab"
              aria-current={selected === "home" ? "page" : undefined}
              onClick={() => onSelect("home")}
            >
              <House aria-hidden="true" size={15} strokeWidth={1.7} />
              Home
            </button>
          )}
          {ordered.map((page) => {
            const { label, icon: Icon } = pagePresentation(page);
            return (
              <PageTab
                key={page.key}
                tabKey={page.key}
                name={label}
                selected={selected === page.key}
                onSelect={() => onSelect(page.key)}
                windows={windows}
                layout={layout.layout}
                tabsHere={tabsHere}
              >
                <Icon aria-hidden="true" size={15} strokeWidth={1.7} />
                {label}
              </PageTab>
            );
          })}
          {panelTabs.map((panel) => {
            const key = panelTabKey(panel);
            return (
              <PageTab
                key={key}
                tabKey={key}
                name={panel.title}
                selected={selected === key}
                onSelect={() => onSelect(key)}
                windows={windows}
                layout={layout.layout}
                tabsHere={tabsHere}
              >
                <LauncherIcon src={panel.launcher?.icon ?? ""} size="size-4" />
                {panel.title}
              </PageTab>
            );
          })}
        </nav>
        <div className="shell-actions" data-tauri-drag-region>
          {main && launchers}
          {main && <PageSearch pages={pages} onSelect={onSelect} />}
          {main && (
            <ProfileButton
              communities={communities}
              settingsSelected={selected === "settings"}
              onSettings={() => onSelect("settings")}
            />
          )}
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
                workspace
                  ? "h-full min-h-0"
                  : "h-full min-h-0 overflow-y-auto px-2 pt-10 pb-8 sm:px-4 sm:pt-14 sm:pb-10"
              }
            >
              <div
                className={
                  workspace ? "h-full min-h-0" : "mx-auto w-full max-w-4xl"
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
