/** Host-owned, device-local appearance. Never depends on plugin/relay readiness. */
export type ColorMode = "light" | "dark";
export type ColorModePreference = ColorMode | "system";
export const APPEARANCE_KEY = "buzz-appearance.v1";
export const FONT_SCALE_KEY = "buzz-font-scale.v1";
export const MIN_FONT_SCALE = 0.8;
export const MAX_FONT_SCALE = 2;
export function parseFontScale(value: unknown): number {
  const number =
    typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" &&
    Number.isFinite(number) &&
    number >= MIN_FONT_SCALE &&
    number <= MAX_FONT_SCALE
    ? Math.round(number * 10) / 10
    : 1;
}
export const parseColorMode = (value: unknown): ColorMode =>
  value === "dark" ? "dark" : "light";
export const parseColorModePreference = (
  value: unknown,
): ColorModePreference =>
  value === "light" || value === "dark" ? value : "system";

export interface AppearanceSnapshot {
  readonly preference: ColorModePreference;
  readonly mode: ColorMode;
  readonly fontScale: number;
  readonly fontError: string | null;
  readonly error: string | null;
}

export function createAppearance(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
) {
  const systemScheme = host?.matchMedia?.("(prefers-color-scheme: dark)");
  const resolvedMode = (preference: ColorModePreference): ColorMode =>
    preference === "system"
      ? systemScheme?.matches
        ? "dark"
        : "light"
      : preference;
  let state: AppearanceSnapshot = {
    preference: "system",
    mode: "light",
    error: null,
    fontScale: 1,
    fontError: null,
  };
  let disposed = false;
  const listeners = new Set<() => void>();
  const apply = () => {
    if (!host) return;
    const root = host.document.documentElement;
    root.dataset.colorMode = state.mode;
    root.style.setProperty("--buzz-text-scale", String(state.fontScale));
    // CSS owns the palette; browser chrome derives from the same canvas token.
    host.document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        host.getComputedStyle(root).getPropertyValue("--workspace").trim(),
      );
  };
  const notify = () => {
    apply();
    for (const listener of listeners) listener();
  };
  const restore = () => {
    try {
      const preference = parseColorModePreference(
        host?.localStorage.getItem(APPEARANCE_KEY),
      );
      state = {
        ...state,
        preference,
        mode: resolvedMode(preference),
        error: null,
      };
    } catch {
      state = {
        ...state,
        error:
          "Appearance could not be restored. Choose a mode to try saving it again.",
      };
    }
    notify();
  };
  const onSystemSchemeChange = () => {
    if (disposed || state.preference !== "system") return;
    const mode = resolvedMode("system");
    if (mode === state.mode) return;
    state = { ...state, mode };
    notify();
  };
  const restoreFont = () => {
    try {
      state = {
        ...state,
        fontScale: parseFontScale(host?.localStorage.getItem(FONT_SCALE_KEY)),
        fontError: null,
      };
    } catch {
      state = {
        ...state,
        fontError:
          "Interface size could not be restored. Choose a size to try saving it again.",
      };
    }
    notify();
  };
  const onStorage = (event: StorageEvent) => {
    if (
      event.key !== APPEARANCE_KEY &&
      event.key !== FONT_SCALE_KEY &&
      event.key !== null
    )
      return;
    // Re-read the current value: an older queued event must not undo a newer save.
    try {
      if (event.storageArea !== host?.localStorage) return;
      if (event.key !== FONT_SCALE_KEY) restore();
      if (event.key !== APPEARANCE_KEY) restoreFont();
    } catch {
      if (event.key !== FONT_SCALE_KEY) restore();
      if (event.key !== APPEARANCE_KEY) restoreFont();
    }
  };
  restore();
  restoreFont();
  host?.addEventListener("storage", onStorage);
  systemScheme?.addEventListener("change", onSystemSchemeChange);
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setMode(preference: ColorModePreference) {
      if (
        disposed ||
        (preference !== "light" &&
          preference !== "dark" &&
          preference !== "system")
      )
        return;
      let error: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(APPEARANCE_KEY, preference);
      } catch {
        error =
          "This appearance is active, but could not be saved on this device. Try again.";
      }
      state = { ...state, preference, mode: resolvedMode(preference), error };
      notify();
    },
    setFontScale(value: number) {
      if (disposed || !Number.isFinite(value)) return;
      const fontScale = parseFontScale(
        Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value)),
      );
      let fontError: string | null = null;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(FONT_SCALE_KEY, String(fontScale));
      } catch {
        fontError =
          "This interface size is active, but could not be saved on this device. Try again.";
      }
      state = { ...state, fontScale, fontError };
      notify();
    },
    dispose() {
      disposed = true;
      host?.removeEventListener("storage", onStorage);
      systemScheme?.removeEventListener("change", onSystemSchemeChange);
      listeners.clear();
    },
  };
}

export type Appearance = ReturnType<typeof createAppearance>;
