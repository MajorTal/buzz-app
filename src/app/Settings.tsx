import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Panel } from "../shared/design-system/ui/Panel";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../shared/design-system/ui/NavigationSection";
import { Button } from "../shared/design-system/ui/Button";
import { Switch } from "../shared/design-system/ui/Switch";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { RecoveryScreen } from "./RecoveryScreen";
import styles from "./Settings.module.css";
import {
  SquaresFourIcon,
  UserIcon,
  PaletteIcon,
  BellIcon,
  RobotIcon,
  ChatCircleIcon,
  KeyboardIcon,
  WrenchIcon,
} from "../shared/design-system/icons/index";
import type { PluginManager } from "../plugins/manager";
import type { Communities } from "../features/communities/service";
import { PluginImport } from "./PluginImport";
import type { Identity } from "../features/identity/service";
import { ProfileSettings } from "./ProfileSettings";

import type { Appearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { NotificationsService } from "../features/notifications/service";
import type { ShortcutsService } from "../features/shortcuts/service";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import { ShortcutSettings } from "./ShortcutSettings";
import { DeveloperSettings } from "./DeveloperSettings";
import { AgentSettings } from "./AgentSettings";
import type { AgentControl } from "../features/agents/control";
import type { SettingsCards } from "../features/settings/service";
import { OwnedContribution } from "../plugins/OwnedContribution";

type Section = { id: string; label: string; icon: typeof UserIcon };

const personalProfile: readonly Section[] = [
  { id: "profile", label: "Profile", icon: UserIcon },
];
const appSections: readonly Section[] = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "notifications", label: "Notifications", icon: BellIcon },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
  { id: "agents", label: "Agents", icon: RobotIcon },
  { id: "plugins", label: "Plugins", icon: SquaresFourIcon },
];
// DEV alone is not enough: packaged desktop builds load a production bundle
// from tauri://localhost, so the hostname check excludes them too.
export const developerMode =
  import.meta.env.DEV &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

export function Settings({
  cards,
  plugins,
  communities,
  identity,
  appearance,
  shortcuts,
  shortcutBindings,
  notifications,
  agentControl,
  navigation,
  onSection,
}: {
  cards: SettingsCards;
  agentControl: AgentControl;
  plugins: PluginManager;
  communities: Communities;
  identity?: Identity | undefined;
  appearance: Appearance;
  shortcuts: ShortcutsService;
  shortcutBindings: ShortcutBindings;
  notifications: NotificationsService;
  navigation?:
    | import("../features/navigation/service").PageNavigation
    | undefined;
  onSection?: (section: string) => void;
}) {
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const selectedCommunity = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  const communityCards = useMemo(
    () => contributed.filter((card) => !card.group),
    [contributed],
  );
  const contributedGroups = useMemo(
    () =>
      [...new Set(contributed.flatMap((card) => card.group ?? []))].map(
        (label) => ({
          label,
          cards: contributed.filter((card) => card.group === label),
        }),
      ),
    [contributed],
  );
  const communitySections: readonly Section[] = useMemo(
    () =>
      selectedCommunity
        ? [
            { id: "profile", label: "Profile", icon: UserIcon },
            ...communityCards.map((card) => ({
              id: card.key,
              label: card.title,
              icon: ChatCircleIcon,
            })),
          ]
        : [],
    [communityCards, selectedCommunity],
  );
  const visibleSections = useMemo(
    () => [
      ...communitySections,
      ...(!selectedCommunity ? personalProfile : []),
      ...contributedGroups.flatMap((group) =>
        group.cards.map((card) => ({
          id: card.key,
          label: card.title,
          icon: ChatCircleIcon,
        })),
      ),
      ...appSections,
      ...(developerMode
        ? [{ id: "developer", label: "Developer", icon: WrenchIcon }]
        : []),
    ],
    [communitySections, contributedGroups, selectedCommunity],
  );
  const defaultSection = selectedCommunity ? "profile" : "appearance";
  const [selected, setSelected] = useState(defaultSection);
  const requestedSection =
    navigation?.target.kind === "settings"
      ? (navigation.target.section ?? defaultSection)
      : undefined;
  useEffect(() => {
    if (
      requestedSection &&
      visibleSections.some((section) => section.id === requestedSection)
    )
      setSelected(requestedSection);
    else if (!visibleSections.some((section) => section.id === selected)) {
      setSelected(defaultSection);
      if (requestedSection === selected) onSection?.(defaultSection);
    }
  }, [defaultSection, onSection, requestedSection, selected, visibleSections]);
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
            <div className={styles.sidebarHeader}>
              <h1 id="settings-title" className="m-0 text-label">
                Settings
              </h1>
            </div>
            <nav aria-label="Settings sections" className={styles.navigation}>
              {selectedCommunity && (
                <NavigationSection label={selectedCommunity.name}>
                  {communitySections.map(({ id, label, icon: Icon }) => (
                    <NavigationItem
                      label={label}
                      icon={<Icon aria-hidden="true" size={18} />}
                      selected={selected === id}
                      type="button"
                      key={id}
                      aria-current={selected === id ? "page" : undefined}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        if (onSection) onSection(id);
                        else setSelected(id);
                      }}
                    />
                  ))}
                </NavigationSection>
              )}
              {contributedGroups.map((group) => (
                <NavigationSection key={group.label} label={group.label}>
                  {group.cards.map((card) => (
                    <NavigationItem
                      label={card.title}
                      selected={selected === card.key}
                      type="button"
                      key={card.key}
                      aria-current={selected === card.key ? "page" : undefined}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        if (onSection) onSection(card.key);
                        else setSelected(card.key);
                      }}
                    />
                  ))}
                </NavigationSection>
              ))}
              <NavigationSection label="App">
                {[
                  ...(!selectedCommunity ? personalProfile : []),
                  ...appSections,
                ].map(({ id, label, icon: Icon }) => (
                  <NavigationItem
                    label={label}
                    icon={<Icon aria-hidden="true" size={18} />}
                    selected={selected === id}
                    type="button"
                    key={id}
                    aria-current={selected === id ? "page" : undefined}
                    onClick={(event) => {
                      event.currentTarget.focus();
                      if (onSection) onSection(id);
                      else setSelected(id);
                    }}
                  />
                ))}
              </NavigationSection>
              {developerMode && (
                <NavigationSection label="Development">
                  <NavigationItem
                    label="Developer"
                    icon={<WrenchIcon aria-hidden="true" size={18} />}
                    selected={selected === "developer"}
                    type="button"
                    aria-current={selected === "developer" ? "page" : undefined}
                    onClick={(event) => {
                      event.currentTarget.focus();
                      if (onSection) onSection("developer");
                      else setSelected("developer");
                    }}
                  />
                </NavigationSection>
              )}
            </nav>
          </aside>
          <div className={styles.detail}>
            <div hidden={selected !== "notifications"}>
              <NotificationSettings
                notifications={notifications}
                active={selected === "notifications"}
              />
            </div>
            <div hidden={selected !== "appearance"}>
              <AppearanceSettings
                appearance={appearance}
                active={selected === "appearance"}
              />
            </div>
            <div hidden={selected !== "shortcuts"}>
              <ShortcutSettings
                shortcuts={shortcuts}
                bindings={shortcutBindings}
                plugins={plugins}
              />
            </div>
            <div hidden={selected !== "agents"}>
              <AgentSettings
                control={agentControl}
                active={selected === "agents"}
              />
            </div>
            {communityCards.map((card) => (
              <div key={card.key} hidden={selected !== card.key}>
                {selected === card.key && (
                  <OwnedContribution entry={card} registry={cards}>
                    {(entry, active) => {
                      const Card = entry.component;
                      return <Card active={active} />;
                    }}
                  </OwnedContribution>
                )}
              </div>
            ))}
            {contributedGroups.flatMap((group) =>
              group.cards.map(
                (card) =>
                  selected === card.key && (
                    <OwnedContribution
                      key={card.key}
                      entry={card}
                      registry={cards}
                    >
                      {(entry, active) => {
                        const Card = entry.component;
                        return <Card active={active} />;
                      }}
                    </OwnedContribution>
                  ),
              ),
            )}
            <div hidden={selected !== "profile"}>
              <ProfileSettings
                key={`${client.viewer}:${selectedCommunity?.id ?? "local"}`}
                communities={communities}
                community={selectedCommunity}
                identity={identity}
                active={selected === "profile"}
              />
            </div>
            {developerMode && (
              <div hidden={selected !== "developer"}>
                <DeveloperSettings relay={communities.relay} />
              </div>
            )}
            <div hidden={selected !== "plugins"}>
              <section aria-labelledby="plugin-settings-title">
                <Header
                  id="plugin-settings-title"
                  title="Plugins"
                  subtitle={
                    !plugins.imports
                      ? "Open the desktop app to load plugins from a folder or Git repository."
                      : undefined
                  }
                />
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
                      <p role="status" className="text-body-sm text-subtle">
                        External plugins are paused for this launch. Your saved
                        enabled settings are unchanged; you can still manage
                        plugins here.
                      </p>
                    )}
                    {selected === "plugins" && refreshError && (
                      <ToastNotice
                        title="Plugin settings couldn’t refresh"
                        description={`Showing the last available configuration; retrying automatically. ${refreshError}`}
                      />
                    )}
                    {selected === "plugins" && error && (
                      <ToastNotice
                        title="Plugin change wasn’t confirmed"
                        description={`Check the current settings before trying again. ${error}`}
                        onDismiss={plugins.dismissError}
                        closeLabel="Dismiss"
                      />
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
                          className="flex flex-wrap items-center justify-between gap-3 px-1 py-3"
                          key={id}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-soft text-muted">
                              <SquaresFourIcon aria-hidden="true" size={17} />
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
                            {/* Channels is required and has no enable/disable control. */}
                            {id !== "buzz.channels" && (
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
                            )}
                            {plugin.previous && (
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => plugins.change("rollback", id)}
                              >
                                Roll back
                              </Button>
                            )}
                            {plugin.reloadable && !plugin.enabled && (
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => plugins.reload(id)}
                              >
                                Reload
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
