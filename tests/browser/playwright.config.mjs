import { defineConfig } from "@playwright/test";

const measurementFiles = ["channel-opening.spec.mjs", "scroll.spec.mjs"];
// Cases that need a scrollbar that takes space. Headless Chromium passes
// --hide-scrollbars by default and only Linux guarantees classic scrollbars,
// so they run in their own Chromium project and never in the engine projects.
const classicScrollbars = /@classic-scrollbars/;

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
      grepInvert: classicScrollbars,
      dependencies: ["webkit-measurements"],
    })),
    {
      name: "chromium-classic-scrollbars",
      use: {
        browserName: "chromium",
        launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
      },
      testIgnore: measurementFiles,
      grep: classicScrollbars,
      // CI runs this project as a second Playwright invocation in the
      // measurements job, and every run clears the outputDir of the projects
      // it selects. A separate directory keeps the measurement evidence intact.
      outputDir: "../../test-results/browser-classic-scrollbars",
      // Locally the full gate still runs measurements first and alone.
      dependencies: ["webkit-measurements"],
    },
  ],
});
