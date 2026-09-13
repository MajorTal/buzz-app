import { useEffect, useState, useSyncExternalStore } from "react";
import { RecoveryScreen } from "./RecoveryScreen";
import { Blocks, Settings2, UserRound, Palette, Bell } from "lucide-react";
import type { PluginManager } from "../plugins/manager";
import type { Communities } from "../features/communities/service";
import { PluginImport } from "./PluginImport";
import { ProfileSettings } from "./ProfileSettings";

import type { Appearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { NotificationsService } from "../features/notifications/service";

const sections = [
  { id: "profile", label: "Profile", icon: UserRound },
  { id: "plugins", label: "Plugins", icon: Blocks },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
] as const;

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
    <section aria-labelledby="settings-title" className="@container">
      <div className="mb-5 flex items-center gap-4">
        <span className="flex size-12 items-center justify-center rounded-2xl border border-shell-edge bg-surface/70 shadow-sm">
          <Settings2 aria-hidden="true" size={23} strokeWidth={1.6} />
        </span>
        <div>
          <h1
            id="settings-title"
            className="m-0 text-3xl font-medium tracking-tight"
          >
            Settings
          </h1>
        </div>
      </div>
      <div className="grid gap-6 @min-[36rem]:grid-cols-[10rem_minmax(0,1fr)]">
        <nav
          aria-label="Settings sections"
          className="flex flex-wrap gap-1 self-start rounded-2xl border border-shell-edge/80 bg-surface/60 p-2 @min-[36rem]:flex-col"
        >
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              aria-current={selected === id ? "page" : undefined}
              className="flex flex-1 items-center gap-3 border-0 bg-transparent px-3 py-2.5 text-left text-muted hover:bg-surface/70 aria-[current=page]:bg-surface aria-[current=page]:text-ink aria-[current=page]:shadow-sm"
              onClick={(event) => {
                event.currentTarget.focus();
                if (onSection) onSection(id);
                else setSelected(id);
              }}
            >
              <Icon aria-hidden="true" size={18} strokeWidth={1.6} />
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          <div hidden={selected !== "notifications"}>
            <NotificationSettings notifications={notifications} />
          </div>
          <div hidden={selected !== "appearance"}>
            <AppearanceSettings appearance={appearance} />
          </div>
          <div hidden={selected !== "profile"}>
            <ProfileSettings communities={communities} />
          </div>
          <div hidden={selected !== "plugins"}>
            <section aria-labelledby="plugin-settings-title">
              <h2
                id="plugin-settings-title"
                className="mt-0 mb-3 text-lg font-medium"
              >
                Plugins
              </h2>
              {catalog ? (
                <PluginImport plugins={plugins} catalog={catalog} busy={busy} />
              ) : configuration.status === "recovery" ? (
                <RecoveryScreen plugins={plugins} />
              ) : (
                <p role="status">
                  Plugin settings are unavailable. Profile and Appearance still
                  work.
                </p>
              )}
              <div className="overflow-hidden rounded-3xl border border-shell-edge/80 bg-surface shadow-surface">
                <div className="px-6 sm:px-8">
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
                      <button type="button" onClick={plugins.dismissError}>
                        Dismiss
                      </button>
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
                              strokeWidth={1.6}
                            />
                          </span>
                          <div className="min-w-0">
                            <h3 className="m-0 text-[length:calc(15px*var(--buzz-text-scale,1))] font-medium">
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
                          <button
                            type="button"
                            role="switch"
                            aria-checked={plugin.enabled}
                            aria-label={`Enable ${plugin.manifest.name}`}
                            className="group flex h-7 w-12 shrink-0 items-center rounded-full border-0 bg-toggle-track p-1 transition-colors motion-reduce:transition-none aria-checked:bg-primary"
                            aria-disabled={busy}
                            onClick={(event) => {
                              if (busy) return;
                              // Keep keyboard focus through the manager's busy transition,
                              // including when disabling a plugin removes its open card.
                              event.currentTarget.focus();
                              void plugins.change(
                                plugin.enabled ? "disable" : "enable",
                                id,
                              );
                            }}
                          >
                            <span className="size-5 rounded-full bg-toggle-thumb shadow-sm transition-transform motion-reduce:transition-none group-aria-checked:translate-x-5" />
                          </button>
                          {plugin.previous && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => plugins.change("rollback", id)}
                            >
                              Roll back
                            </button>
                          )}
                          {plugin.source === "external" && (
                            <button
                              type="button"
                              className="danger"
                              disabled={busy}
                              onClick={() => plugins.change("remove", id)}
                            >
                              Delete
                            </button>
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
    </section>
  );
}
