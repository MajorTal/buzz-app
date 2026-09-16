import { defineConfig } from "@playwright/test";

const measurementFiles = ["channel-opening.spec.mjs", "scroll.spec.mjs"];

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  outputDir: "../../test-results/browser",
  // Functional journeys share two workers; measurements run first and alone.
  // Never hide failures with retries or measure opening under another browser's load.
  workers: 2,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    viewport: { width: 1440, height: 950 },
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-measurements",
      use: { browserName: "chromium" },
      testMatch: measurementFiles,
      workers: 1,
    },
    {
      name: "webkit-measurements",
      use: { browserName: "webkit" },
      testMatch: measurementFiles,
      workers: 1,
      dependencies: ["chromium-measurements"],
    },
    ...["chromium", "webkit"].map((browserName) => ({
      name: browserName,
      use: { browserName },
      testIgnore: measurementFiles,
      dependencies: ["webkit-measurements"],
      fullyParallel: true,
    })),
  ],
});
