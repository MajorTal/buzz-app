import { defineConfig } from "vitest/config";
import { fixtureAliases } from "./tests/relay-config.ts";
export default defineConfig({
  define: {
    "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES":
      JSON.stringify(fixtureAliases),
  },
  test: {
    include: [
      "scripts/design-system/**/*.test.mjs",
      "src/**/*.test.{ts,tsx,mjs}",
      "dev/**/*.test.mjs",
      "tests/fixtures/design-system/**/*.test.{ts,tsx}",
    ],
  },
});
