import { defineConfig } from "@playwright/test";

// Focused offline UI iteration. The integration owner imports the journey from
// tests/browser/workflows.spec.mjs so the ordinary browser lanes also run it.
export default defineConfig({
  testDir: ".",
  testMatch: "workflows.journey.mjs",
  outputDir: "../../../test-results/workflows",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    headless: true,
    actionTimeout: 5_000,
    viewport: { width: 1000, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: ["chromium", "webkit"].map((browserName) => ({
    name: browserName,
    use: { browserName },
  })),
});
