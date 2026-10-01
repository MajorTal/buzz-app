import type { ShortcutsService } from "../features/shortcuts/service";
import type { Appearance } from "../shared/theme/service";

/** Host actions use the same binding/dispatch rules as plugins, without fake plugin ownership. */
// Settings presents the host category in functional sections: navigation,
// interface sizing, search/settings, then app reload.
export const HOST_SHORTCUT_ORDER = {
  home: 10,
  navigationBack: 20,
  navigationForward: 30,
  textSizeIncrease: 40,
  textSizeDecrease: 50,
  textSizeReset: 60,
  search: 70,
  settings: 80,
  reload: 90,
} as const;

export function registerAppShortcuts(
  shortcuts: ShortcutsService,
  appearance: Appearance,
  openSettings: () => void,
  ready: boolean,
) {
  const remove = [
    shortcuts.registerHost({
      id: "settings",
      title: "Open Settings",
      binding: { key: ",", mod: true },
      order: HOST_SHORTCUT_ORDER.settings,
      allowInEditable: true,
      when: () => ready,
      run: openSettings,
    }),
    ...(
      [
        [
          "font-increase",
          "Increase interface size",
          HOST_SHORTCUT_ORDER.textSizeIncrease,
          [
            { key: "=", mod: true },
            { key: "=", mod: true, shift: true },
            { key: "+", mod: true },
            { key: "+", mod: true, shift: true },
          ],
          () => appearance.setFontScale(appearance.snapshot().fontScale + 0.1),
        ],
        [
          "font-decrease",
          "Decrease interface size",
          HOST_SHORTCUT_ORDER.textSizeDecrease,
          { key: "-", mod: true },
          () => appearance.setFontScale(appearance.snapshot().fontScale - 0.1),
        ],
        [
          "font-reset",
          "Reset interface size",
          HOST_SHORTCUT_ORDER.textSizeReset,
          { key: "0", mod: true },
          () => appearance.setFontScale(1),
        ],
      ] as const
    ).map(([id, title, order, binding, run]) =>
      shortcuts.registerHost({
        id,
        title,
        order,
        binding,
        run,
        allowInEditable: true,
        allowInModal: true,
        repeat: true,
      }),
    ),
  ];
  remove.push(
    shortcuts.registerHost({
      id: "app-reload",
      title: "Reload Buzz",
      binding: { key: "r", mod: true },
      order: HOST_SHORTCUT_ORDER.reload,
      allowInEditable: true,
      allowInModal: true,
      run: () => window.location.reload(),
    }),
  );
  return () => {
    for (const dispose of remove) dispose();
  };
}

export function registerNavigationShortcuts(
  shortcuts: ShortcutsService,
  navigation: import("../features/navigation/controller").Navigation,
) {
  const remove = [
    shortcuts.registerHost({
      id: "home",
      title: "Home",
      order: HOST_SHORTCUT_ORDER.home,
      binding: { key: "a", mod: true, shift: true },
      allowInEditable: true,
      run: () =>
        navigation.open({ version: 1, kind: "home" }).then(() => undefined),
    }),
    shortcuts.registerHost({
      id: "navigation-back",
      title: "Go back",
      order: HOST_SHORTCUT_ORDER.navigationBack,
      binding: { key: "[", mod: true },
      allowInEditable: true,
      when: () => navigation.snapshot().canGoBack,
      run: navigation.back,
    }),
    shortcuts.registerHost({
      id: "navigation-forward",
      title: "Go forward",
      order: HOST_SHORTCUT_ORDER.navigationForward,
      binding: { key: "]", mod: true },
      allowInEditable: true,
      when: () => navigation.snapshot().canGoForward,
      run: navigation.forward,
    }),
  ];
  return () => {
    for (const dispose of remove) dispose();
  };
}
