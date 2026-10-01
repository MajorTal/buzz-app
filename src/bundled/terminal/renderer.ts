import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import { forwardTerminalKey } from "../../features/shortcuts/terminal-key-event";
import { terminalAppearance } from "./appearance";
import { createSplash } from "./splash";
import styles from "./Terminal.module.css";

export type TerminalInputSource = "user" | "reply";
export type TerminalScreen = {
  mount(host: HTMLElement): () => void;
  output(data: Uint8Array): Promise<void>;
  dispose(): void;
};
export function createScreen(
  input: (data: string, source: TerminalInputSource) => void,
  resize: (cols: number, rows: number) => void,
): TerminalScreen {
  const element = document.createElement("div");
  element.dataset.buzzUi = "";
  element.className = `${styles.emulator} text-mono font-mono`;
  const terminal = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    minimumContrastRatio: 4.5,
  });
  const splash = createSplash(element, () => terminal.focus());
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  // xterm 5.5.0's public onData drops the producer's wasUserInput flag.
  // Its core signal fires synchronously immediately before keyboard/paste data,
  // but not for parser replies. Keep this version-pinned seam here, never infer
  // provenance from escape bytes or from an asynchronous write being pending.
  const core = (
    terminal as unknown as {
      _core: {
        coreService: {
          onUserInput(listener: () => void): { dispose(): void };
        };
      };
    }
  )._core.coreService;
  let userInput = false;
  const inputSource = core.onUserInput(() => {
    userInput = true;
  });
  terminal.onData((data) => {
    const source = userInput ? "user" : "reply";
    userInput = false;
    if (source === "user") {
      if (!element.isConnected) return;
      splash.dismiss();
    }
    input(data, source);
  });
  terminal.onResize(({ cols, rows }) => resize(cols, rows));
  // Let the single dispatcher resolve live bindings before xterm writes PTY
  // bytes. A handled event is prevented, so bubbling cannot dispatch it twice.
  terminal.attachCustomKeyEventHandler((event) => {
    const host = element.ownerDocument.defaultView;
    return !disposed && element.isConnected && host
      ? forwardTerminalKey(host, event)
      : true;
  });
  let opened = false;
  let disposed = false;
  let receivedOutput = false;
  let detach: (() => void) | undefined;
  const pending = new Set<() => void>();
  return {
    mount(host) {
      detach?.();
      host.append(element);
      terminal.options = terminalAppearance(element);
      if (!opened) {
        terminal.open(element);
        opened = true;
      }
      let attached = true;
      const update = () => {
        if (!attached || disposed) return;
        terminal.options = terminalAppearance(element);
        if (host.clientWidth && host.clientHeight) {
          fit.fit();
          splash.layout();
          if (receivedOutput) splash.show();
        }
      };
      const observer = new ResizeObserver(update);
      observer.observe(host);
      const appearance = new MutationObserver(update);
      appearance.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-color-mode", "style", "class"],
      });
      element.addEventListener("keydown", splash.dismiss);
      update();
      // Loaded mono metrics can differ from the fallback used on first mount.
      void document.fonts.ready.then(update);
      terminal.focus();
      const cleanup = () => {
        attached = false;
        observer.disconnect();
        appearance.disconnect();
        element.removeEventListener("keydown", splash.dismiss);
        splash.dismiss();
        element.remove();
        if (detach === cleanup) detach = undefined;
      };
      detach = cleanup;
      return cleanup;
    },
    output(data) {
      if (disposed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending.add(resolve);
        terminal.write(data, () => {
          if (!disposed && data.length) {
            receivedOutput = true;
            splash.show();
          }
          pending.delete(resolve);
          resolve();
        });
      });
    },
    dispose() {
      disposed = true;
      detach?.();
      splash.dismiss();
      inputSource.dispose();
      terminal.dispose();
      element.remove();
      for (const resolve of pending) resolve();
      pending.clear();
    },
  };
}
