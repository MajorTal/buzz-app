import { defineConfig } from "@playwright/test";
import base from "./websocket-profile.config.mjs";
export default defineConfig({
  ...base,
  testMatch: "startup-subscriptions.profile.mjs",
  outputDir: "../../test-results/startup-profile",
  // 332 channels at four setups/sec is ~83s, plus cold app/fixture setup.
  timeout: 130000,
});
