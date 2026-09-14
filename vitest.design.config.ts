import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "scripts/design-system/**/*.test.mjs",
      "src/shared/design-system/**/*.test.ts",
      "tests/fixtures/design-system/**/*.test.ts",
    ],
  },
});
