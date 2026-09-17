import { Panel } from "../shared/design-system/ui/Panel";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { Button } from "../shared/design-system/ui/Button";
import { Switch } from "../shared/design-system/ui/Switch";
import { useEffect, useState, useSyncExternalStore } from "react";
import { RecoveryScreen } from "./RecoveryScreen";
import styles from "./Settings.module.css";
import {
  IconBlocks as Blocks,
  IconUser as UserRound,
  IconPalette as Palette,
  IconBell as Bell,
  IconTool as Wrench,
} from "@tabler/icons-react";
import type { PluginManager } from "../plugins/manager";
import type { Communities } from "../features/communities/service";
import { PluginImport } from "./PluginImport";
import { ProfileSettings } from "./ProfileSettings";

import type { Appearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { NotificationsService } from "../features/notifications/service";
import { DeveloperSettings } from "./DeveloperSettings";

type Section = { id: string; label: string; icon: typeof UserRound };

const baseSections: Section[] = [
  { id: "profile", label: "Profile", icon: UserRound },
  { id: "plugins", label: "Plugins", icon: Blocks },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
];

// DEV alone is not enough: packaged desktop builds load a production bundle
// from tauri://localhost, so the hostname check excludes them too.
export const developerMode =
  import.meta.env.DEV &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

const sections: Section[] = developerMode
  ? [...baseSections, { id: "developer", label: "Developer", icon: Wrench }]
  : baseSections;

export function Settings({
  plugins,
  communities,
  appearance,
  notifications,
  navigation,
  onSection,
}: {
  plugins: PluginManager;
  communities: Communities;
  appearance: Appearance;
  notifications: NotificationsService;
  navigation?:
    | import("../features/navigation/service").PageNavigation
    | undefined;
  onSection?: (section: string) => void;
}) {
  const [selected, setSelected] =
    useState<(typeof sections)[number]["id"]>("profile");
  const requestedSection =
    navigation?.target.kind === "settings"
      ? (navigation.target.section ?? "profile")
      : undefined;
  useEffect(() => {
    if (
      requestedSection &&
      sections.some((section) => section.id === requestedSection)
    )
      setSelected(requestedSection as typeof selected);
  }, [requestedSection]);
  useEffect(() => {
    if (requestedSection === selected)
      navigation?.complete({ status: "opened" });
  }, [navigation, requestedSection, selected]);
  const { configuration, activation, busy, error, refreshError } =
    useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const ready = configuration.status === "ready" ? configuration : undefined;
  const catalog = ready?.catalog;
  const externalPluginsPaused = ready?.externalPluginsPaused;
  return (
    <div className={styles.root}>
      <Panel aria-labelledby="settings-title">
        <div className={styles.layout}>
          <aside className={styles.sidebar}>
            <h1 id="settings-title" className="m-0 px-3 py-4 text-label">
              Settings
            </h1>
            <nav aria-label="Settings sections" className={styles.navigation}>
              {sections.map(({ id, label, icon: Icon }) => (
                <NavigationItem
                  type="button"
                  key={id}
                  aria-current={selected === id ? "page" : undefined}
                  selected={selected === id}
                  label={label}
                  icon={<Icon aria-hidden="true" size={18} stroke={1.6} />}
                  onClick={(event) => {
                    event.currentTarget.focus();
                    if (onSection) onSection(id);
                    else setSelected(id);
                  }}
                />
              ))}
            </nav>
          </aside>
          <div className={styles.detail}>
            <div hidden={selected !== "notifications"}>
              <NotificationSettings notifications={notifications} />
            </div>
            <div hidden={selected !== "appearance"}>
              <AppearanceSettings appearance={appearance} />
            </div>
            <div hidden={selected !== "profile"}>
              <ProfileSettings communities={communities} />
            </div>
            {developerMode && (
              <div hidden={selected !== "developer"}>
                <DeveloperSettings relay={communities.relay} />
              </div>
            )}
            <div hidden={selected !== "plugins"}>
              <section aria-labelledby="plugin-settings-title">
                <h2 id="plugin-settings-title" className="mt-0 mb-6 text-label">
                  Plugins
                </h2>
                {catalog ? (
                  <PluginImport
                    plugins={plugins}
                    catalog={catalog}
                    busy={busy}
                  />
                ) : configuration.status === "recovery" ? (
                  <RecoveryScreen plugins={plugins} />
                ) : (
                  <p role="status">
                    Plugin settings are unavailable. Profile and Appearance
                    still work.
                  </p>
                )}
                <div className="overflow-hidden">
                  <div>
                    {externalPluginsPaused && (
                      <p role="status" className="notice">
                        External plugins are paused for this launch. Your saved
                        enabled settings are unchanged; you can still manage
                        plugins here.
                      </p>
                    )}
                    {refreshError && (
                      <div role="alert" className="notice">
                        <p>
                          Couldn’t refresh plugin settings. Showing the last
                          available configuration; retrying automatically.
                        </p>
                        <p>{refreshError}</p>
                      </div>
                    )}
                    {error && (
                      <div role="alert" className="notice">
                        <p>
                          That change could not be confirmed. Check the current
                          settings before trying again.
                        </p>
                        <p>{error}</p>
                        <Button type="button" onClick={plugins.dismissError}>
                          Dismiss
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="divide-y divide-line">
                    {catalog?.plugins.map((plugin) => {
                      const id = plugin.manifest.id;
                      const running = activation[id];
                      const failure =
                        plugin.error ??
                        (running?.revision === plugin.revision
                          ? running.error
                          : null);
                      return (
                        <article
                          className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                          key={id}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-soft text-muted">
                              <Blocks
                                aria-hidden="true"
                                size={17}
                                stroke={1.6}
                              />
                            </span>
                            <div className="min-w-0">
                              <h3 className="m-0 text-label font-medium">
                                {plugin.manifest.name}
                              </h3>
                              {failure && (
                                <p role="alert" className="error">
                                  {failure}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="actions items-center">
                            <Switch
                              aria-label={`Enable ${plugin.manifest.name}`}
                              checked={plugin.enabled}
                              readOnly={busy}
                              aria-disabled={busy}
                              onClick={(event) => event.currentTarget.focus()}
                              onCheckedChange={() => {
                                if (busy) return;
                                void plugins.change(
                                  plugin.enabled ? "disable" : "enable",
                                  id,
                                );
                              }}
                            />
                            {plugin.previous && (
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => plugins.change("rollback", id)}
                              >
                                Roll back
                              </Button>
                            )}
                            {plugin.source === "external" && (
                              <Button
                                type="button"
                                variant="destructive"
                                disabled={busy}
                                onClick={() => plugins.change("remove", id)}
                              >
                                Delete
                              </Button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
