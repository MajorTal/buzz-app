import { Context } from "@deepseek-ai/cordis";
import { createRoot } from "react-dom/client";
import { useSyncExternalStore } from "react";
import { PluginRuntime } from "../../src/plugins/runtime";
import { PagesService } from "../../src/features/pages/service";
import { PageView } from "../../src/features/pages/PageView";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import * as plugin from "../../src/bundled/link-lab";
import manifest from "../../src/bundled/link-lab/manifest.json";
import "../../src/shared/design-system/styles/globals.css";
import "./link-lab.css";

// Isolated visual preview: real plugin activation, no relay or identity services.
document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);
const root = new Context();
const runtime = new PluginRuntime(root, async () => plugin);
const pages = new PagesService(root);
runtime.reconcile([
  {
    manifest: { ...manifest, apiVersion: 1 },
    enabled: true,
    source: "bundled",
    revision: "preview",
    previous: null,
    error: null,
  },
]);
function Preview() {
  useKeyboardFocusVisibility();
  const entries = useSyncExternalStore(pages.subscribe, pages.snapshot);
  return entries[0] ? <PageView page={entries[0]} /> : <p>Opening Link Lab…</p>;
}
const mount = document.getElementById("root");
if (!mount) throw new Error("Missing preview root");
createRoot(mount).render(<Preview />);
import.meta.hot?.dispose(() => {
  void runtime.dispose();
  void root.fiber.dispose();
});
