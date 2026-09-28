import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { desktopOverlay, options } from "./desktop-config.mjs";

// A debug bundle for the one thing `just desktop` cannot do: macOS routes a URL
// scheme only to a bundled application, so testing OS deep links there needs a
// bundle registered with Launch Services. Windows and Linux can also use a debug
// build for packaged deep-link behavior; ordinary `just desktop` deliberately
// leaves the OS handler alone. All packaged builds use `buzz`.
// Release bundling stays a plain `pnpm tauri build`.
const args = process.argv.slice(2);
const { forwarded, rest } = options(args, []);
const root = fileURLToPath(new URL("../", import.meta.url));
// `--bundles app` is the cheapest bundle Launch Services will read; a caller who
// wants another format, or none, says so and keeps that choice.
const chose = forwarded.some(
  (arg) =>
    arg === "--bundles" ||
    arg.startsWith("--bundles=") ||
    arg === "--no-bundle",
);
const defaults = chose ? ["--debug"] : ["--debug", "--bundles", "app"];
// Prepend, as `just desktop` does: Tauri treats everything after a bare positional
// as runner arguments, and a user's own --config must merge after ours to win. With
// no worktree icon there is nothing to overlay, and no --config is
// passed, so the bundle is exactly what `tauri build` would produce on its own.
const overlay = desktopOverlay(root);
if (Object.keys(overlay).length > 0)
  forwarded.unshift("--config", JSON.stringify(overlay));
forwarded.push(...rest);
const result = spawnSync(
  "pnpm",
  ["tauri", "build", ...defaults, ...forwarded],
  {
    stdio: "inherit",
  },
);
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
