/** Development diagnostics for the warm/preparation paths. Enable per browser
 * with localStorage "buzz.debug.relay" = "1"; never active in other tabs or builds. */
export function relayDebug(...parts: readonly unknown[]): void {
  try {
    if (globalThis.localStorage?.getItem("buzz.debug.relay") !== "1") return;
  } catch {
    return;
  }
  console.info("[relay]", ...parts);
}
