// FOUNDATION: Startup, navigation, contributed pages, and built-in Settings.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { registerAppShortcuts } from "./shortcuts";
import type { AppServices } from "./services";
import { Settings } from "./Settings";
import { RecoveryScreen } from "./RecoveryScreen";
import { PageView } from "../features/pages/PageView";
import { useAppNavigation } from "./navigation";
import { NavigationControls } from "./shell/NavigationControls";
import { registerNavigationShortcuts } from "./shortcuts";
import { AppShell } from "./shell/AppShell";
import { Home } from "./shell/Home";
import { pagePresentation, shellPresentation } from "./shell/presentation";
import { usePanelLauncher } from "./shell/usePanelLauncher";
import { PanelLaunchers } from "./shell/PanelLaunchers";
import { EmptyWindow } from "./shell/EmptyWindow";
import { PanelCard } from "../features/panels/PanelCard";
import { PanelView } from "../features/panels/PanelView";
import { panelTabKey, windowPanels } from "../features/windows/service";

export function App({ services }: { services: AppServices }) {
  const { plugins, windows } = services;
  const startup = useSyncExternalStore(plugins.subscribe, plugins.startup);
  const route = useAppNavigation(services);
  const launcher = usePanelLauncher(services.panels, startup === "ready");
  const home = route.target.kind === "home" && windows.isMain;
  const settings = route.target.kind === "settings" && windows.isMain;
  const layout = useSyncExternalStore(windows.subscribe, windows.snapshot);
  // Launcher panels follow the window layout too: launchers in main, tabs elsewhere.
  const panels = windowPanels(layout.layout, windows.label, launcher.available);
  const [panelChoice, setPanelChoice] = useState<string>();
  const panelTab = windows.isMain
    ? undefined
    : (panels.find((panel) => panelTabKey(panel) === panelChoice) ??
      (route.pages.length === 0 ? panels[0] : undefined));
  // A detached window keeps its shell when its tabs leave; it never shows Home.
  const emptyWindow =
    !windows.isMain &&
    layout.status === "ready" &&
    startup === "ready" &&
    route.pages.length === 0 &&
    panels.length === 0;
  const select = (key: string) => {
    if (key.startsWith("panel:")) {
      setPanelChoice(key);
      return;
    }
    setPanelChoice(undefined);
    route.select(key);
  };
  // A tab moved here from another window becomes the selected tab, once this
  // window's layout shows it. Main keeps launcher panels as launchers.
  const activate = layout.activate;
  const activated = useRef(0);
  useEffect(() => {
    if (!activate || activate.seq === activated.current) return;
    const key = activate.key;
    const present = key.startsWith("panel:")
      ? !windows.isMain && panels.some((panel) => panelTabKey(panel) === key)
      : route.pages.some((page) => page.key === key);
    if (!present) return;
    activated.current = activate.seq;
    select(key);
  });
  useEffect(
    () =>
      registerAppShortcuts(
        services.shortcuts,
        services.appearance,
        () => {
          void services.navigation.open({ version: 1, kind: "settings" });
          document.getElementById("main-content")?.focus();
        },
        true,
      ),
    [services],
  );
  useEffect(
    () => registerNavigationShortcuts(services.shortcuts, services.navigation),
    [services],
  );
  const presentation = home
    ? shellPresentation.home
    : route.page
      ? pagePresentation(route.page)
      : shellPresentation.settings;
  const selectedPanel =
    launcher.selected && panels.includes(launcher.selected)
      ? launcher.selected
      : undefined;
  const companion = selectedPanel && (
    <PanelCard
      panel={selectedPanel}
      target={selectedPanel.launcher?.target ?? ""}
      close={launcher.close}
    />
  );
  const pageOwnsCompanion = !home && !!route.page?.companion;
  return (
    <AppShell
      navigationControls={
        <NavigationControls navigation={services.navigation} />
      }
      onCommunitySelect={(id) => {
        services.communities.select(id);
        select("buzz.channels/channels");
      }}
      communities={services.communities}
      windows={windows}
      launchers={
        <PanelLaunchers
          panels={panels}
          selected={selectedPanel}
          launch={launcher.launch}
          windows={windows}
          layout={layout.layout}
          tabsHere={route.pages.length + panels.length}
        />
      }
      companion={pageOwnsCompanion ? undefined : companion}
      pages={startup === "ready" ? route.pages : []}
      panelTabs={windows.isMain || startup !== "ready" ? [] : panels}
      selected={panelTab ? panelTabKey(panelTab) : route.selected}
      onSelect={select}
      tone={panelTab ? shellPresentation.home.tone : presentation.tone}
      workspace={
        !!panelTab ||
        (startup === "ready" && !home && route.page?.layout === "workspace")
      }
    >
      {emptyWindow ? (
        <EmptyWindow windows={windows} />
      ) : panelTab ? (
        <PanelView
          panel={panelTab}
          target={panelTab.launcher?.target ?? ""}
          close={() => void windows.moveTab?.(panelTabKey(panelTab), "main")}
        />
      ) : route.failure || route.state.status === "failed" ? (
        <div role="alert" className="notice">
          <h1>This destination couldn’t open</h1>
          <p>
            {route.failure === "denied"
              ? "This target needs its original account and an already joined community."
              : "The destination is unavailable or isn’t supported yet. Your target has been kept for retry."}
          </p>
          <button type="button" onClick={route.retry}>
            Retry navigation
          </button>
          <button type="button" onClick={() => select("home")}>
            Go Home
          </button>
        </div>
      ) : settings ? (
        <Settings
          plugins={plugins}
          communities={services.communities}
          appearance={services.appearance}
          notifications={services.notifications}
          navigation={route.request}
          onSection={(section) =>
            void services.navigation.open({
              version: 1,
              kind: "settings",
              section,
            })
          }
        />
      ) : home ? (
        <Home pages={route.pages} onSelect={select} />
      ) : startup === "recovery" ? (
        <RecoveryScreen plugins={plugins} />
      ) : route.waiting || startup === "loading" ? (
        <p role="status">Opening destination…</p>
      ) : route.page ? (
        <PageView
          page={route.page}
          navigation={route.request}
          companion={pageOwnsCompanion ? companion : undefined}
        />
      ) : null}
    </AppShell>
  );
}
