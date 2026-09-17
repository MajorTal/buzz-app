import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/shared/design-system/**/*.test.{ts,tsx}",
      "tests/fixtures/design-system/**/*.test.ts",
    ],
  },
});
