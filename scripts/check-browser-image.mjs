import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export function imageEngines(image, installedVersion, engine) {
  assert.equal(
    image.driverVersion,
    installedVersion,
    "CI browser image must match installed Playwright",
  );
  assert.equal(
    image.dockerImageName,
    `mcr.microsoft.com/playwright:v${installedVersion}-noble`,
  );
  assert.ok(
    ["all", "chromium", "webkit"].includes(engine),
    "Unsupported browser engine",
  );
  return engine === "all" ? ["chromium", "webkit"] : [engine];
}

async function main() {
  const engines = imageEngines(
    JSON.parse(readFileSync("/ms-playwright/.docker-info", "utf8")),
    require("@playwright/test/package.json").version,
    process.env.PLAYWRIGHT_ENGINE ?? "all",
  );
  const playwright = require("@playwright/test");
  for (const engine of engines) {
    // Launch, do not just check a path: missing OS libraries must fail setup.
    const browser = await playwright[engine].launch();
    try {
      const page = await browser.newPage();
      await page.setContent("<p>Browser ready</p>");
      assert.equal(await page.locator("p").textContent(), "Browser ready");
      console.log(`${engine}: pinned image browser launched`);
    } finally {
      await browser.close();
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
