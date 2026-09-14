import type { Plugin } from "vite";
export function taskStorePlugin(options: {
  viewer?: string | undefined;
  file?: string | undefined;
}): Plugin;
