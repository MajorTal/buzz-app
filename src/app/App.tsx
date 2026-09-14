// FOUNDATION: Startup, navigation, contributed pages, and built-in Settings.
import { useEffect, useSyncExternalStore } from "react";
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
import { PanelCard } from "../features/panels/PanelCard";

export function App({ services }: { services: AppServices }) {
  const { plugins } = services;
  const startup = useSyncExternalStore(plugins.subscribe, plugins.startup);
  const route = useAppNavigation(services);
  const launcher = usePanelLauncher(services.panels, startup === "ready");
  const home = route.target.kind === "home";
  const settings = route.target.kind === "settings";
  const select = route.select;
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
  const selectedPanel = launcher.selected;
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
      launchers={
        <PanelLaunchers
          panels={launcher.available}
          selected={selectedPanel}
          launch={launcher.launch}
        />
      }
      companion={pageOwnsCompanion ? undefined : companion}
      pages={startup === "ready" ? route.pages : []}
      selected={route.selected}
      onSelect={select}
      tone={presentation.tone}
      workspace={
        startup === "ready" && !home && route.page?.layout === "workspace"
      }
    >
      {route.failure || route.state.status === "failed" ? (
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
