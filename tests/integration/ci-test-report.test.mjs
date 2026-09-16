import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  formatSummary,
  parsePlaywright,
  parseVitest,
} from "../../scripts/ci-test-report.mjs";

test("Vitest aggregation preserves asymmetric counts and costs", () => {
  const report = parseVitest({
    numTotalTests: 5,
    numPassedTests: 2,
    numFailedTests: 1,
    numPendingTests: 1,
    numTodoTests: 1,
    success: false,
    testResults: [
      {
        name: "/repo/src/a|file.test.ts",
        startTime: 100,
        endTime: 130,
        assertionResults: [
          { fullName: "slow | test", status: "failed", duration: 21 },
          { fullName: "fast", status: "passed", duration: 3 },
        ],
      },
      {
        name: "/repo/src/b.test.ts",
        startTime: 200,
        endTime: 207,
        assertionResults: [
          { fullName: "other", status: "passed", duration: 5 },
        ],
      },
    ],
  });

  assert.deepEqual(report.counts, {
    total: 5,
    passed: 2,
    failed: 1,
    skipped: 2,
  });
  assert.equal(report.testDurationMs, 29);
  assert.deepEqual(report.slowestTests[0], {
    name: "slow | test",
    file: "/repo/src/a|file.test.ts",
    durationMs: 21,
  });
  assert.equal(report.slowestFiles[0].durationMs, 30);
  assert.equal(report.complete, false);
});

test("Playwright aggregation sums results without confusing runner elapsed time", () => {
  const report = parsePlaywright({
    errors: [],
    stats: { expected: 2, unexpected: 1, skipped: 1, flaky: 0 },
    suites: [
      {
        specs: [
          {
            file: "a.spec.mjs",
            title: "uneven",
            tests: [
              {
                projectName: "chromium-measurements",
                results: [{ status: "passed", duration: 13 }],
              },
              {
                projectName: "webkit-measurements",
                results: [{ status: "failed", duration: 41 }],
              },
            ],
          },
          {
            file: "b.spec.mjs",
            title: "small",
            tests: [
              {
                projectName: "",
                results: [{ status: "passed", duration: 7 }],
              },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(report.counts, {
    total: 4,
    passed: 2,
    failed: 1,
    skipped: 1,
  });
  assert.equal(report.testDurationMs, 61);
  assert.equal(report.slowestFiles[0].durationMs, 54);
  assert.equal(report.complete, false);
  assert.deepEqual(JSON.parse(JSON.stringify(report)).slowestTests, [
    {
      name: "uneven",
      projectName: "webkit-measurements",
      file: "a.spec.mjs",
      durationMs: 41,
    },
    {
      name: "uneven",
      projectName: "chromium-measurements",
      file: "a.spec.mjs",
      durationMs: 13,
    },
    {
      name: "small",
      projectName: "",
      file: "b.spec.mjs",
      durationMs: 7,
    },
  ]);
  const summary = formatSummary("Measurements", report, 50);
  assert.ok(
    summary.includes("| [webkit-measurements] uneven | a.spec.mjs | 41 ms |"),
  );
  assert.ok(
    summary.includes("| [chromium-measurements] uneven | a.spec.mjs | 13 ms |"),
  );
  assert.ok(summary.includes("| small | b.spec.mjs | 7 ms |"));
});

test("summary escapes runner content and labels missing reports incomplete", () => {
  const summary = formatSummary(
    "Vitest | tests",
    {
      complete: false,
      counts: { total: 1, passed: 0, failed: 1, skipped: 0 },
      testDurationMs: 10,
      slowestTests: [{ name: "bad\nname", file: "a|b", durationMs: 10 }],
      slowestFiles: [],
    },
    37,
  );
  assert.match(summary, /Status \| Incomplete or failed/);
  assert.match(summary, /Elapsed wall time \| 37 ms/);
  assert.match(summary, /Summed test execution time \| 10 ms/);
  assert.match(summary, /bad name/);
  assert.match(summary, /a\\\|b/);
  assert.match(
    formatSummary("Playwright", null, 12, "report missing"),
    /Report unavailable.*report missing/,
  );
});

test("CLI preserves runner failure and fails successful runs with missing reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "buzz-ci-report-cli-"));
  const report = join(directory, "report.json");
  const evidence = join(directory, "evidence.json");
  const summary = join(directory, "summary.md");
  const script = fileURLToPath(
    new URL("../../scripts/ci-test-report.mjs", import.meta.url),
  );
  const invoke = (child) =>
    spawnSync(
      process.execPath,
      [
        script,
        "kind=vitest",
        `report=${report}`,
        `evidence=${evidence}`,
        "title=test",
        "--",
        process.execPath,
        "-e",
        child,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      },
    );
  try {
    const source = {
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      success: false,
      testResults: [],
    };
    const failed = invoke(
      `require('node:fs').writeFileSync(${JSON.stringify(report)}, ${JSON.stringify(JSON.stringify(source))}); process.exit(7)`,
    );
    assert.equal(failed.status, 7);
    assert.equal(JSON.parse(readFileSync(evidence)).report.complete, false);

    const incomplete = invoke(
      `require('node:fs').writeFileSync(${JSON.stringify(report)}, ${JSON.stringify(JSON.stringify(source))})`,
    );
    assert.equal(incomplete.status, 1);

    const missing = invoke("process.exit(0)");
    assert.equal(missing.status, 1);
    assert.match(readFileSync(summary, "utf8"), /Report unavailable/);
    assert.match(JSON.parse(readFileSync(evidence)).reportError, /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("built-in Vitest and Playwright JSON reporters retain their expected shape", () => {
  mkdirSync(new URL("../../test-results/", import.meta.url), {
    recursive: true,
  });
  const directory = mkdtempSync(
    fileURLToPath(new URL("../../test-results/ci-report-", import.meta.url)),
  );
  const vitestConfig = join(directory, "vitest.config.mjs");
  const vitestTest = join(directory, "sample.test.mjs");
  const vitestReport = join(directory, "vitest.json");
  const playwrightConfig = join(directory, "playwright.config.mjs");
  const playwrightTest = join(directory, "sample.spec.mjs");
  const playwrightReport = join(directory, "playwright.json");
  try {
    writeFileSync(
      vitestConfig,
      `export default { test: { include: [${JSON.stringify(vitestTest)}] } };\n`,
    );
    writeFileSync(
      vitestTest,
      "import { test } from 'vitest'; test('pass', () => {}); test.skip('skip', () => {}); test.todo('todo');\n",
    );
    execFileSync(
      "bin/pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        vitestConfig,
        "--reporter=json",
        `--outputFile=${vitestReport}`,
      ],
      { cwd: new URL("../..", import.meta.url), stdio: "ignore" },
    );
    const vitest = parseVitest(JSON.parse(readFileSync(vitestReport)));
    assert.equal(vitest.complete, true);
    assert.deepEqual(vitest.counts, {
      total: 3,
      passed: 1,
      failed: 0,
      skipped: 2,
    });
    assert.ok(Number.isFinite(vitest.testDurationMs));
    assert.ok(vitest.slowestTests.length > 0);
    assert.ok(vitest.slowestFiles.length > 0);

    writeFileSync(
      playwrightConfig,
      `export default { testDir: ${JSON.stringify(directory)}, testMatch: '**/*.spec.mjs', outputDir: ${JSON.stringify(join(directory, "output"))}, projects: [{ name: 'chromium-measurements' }, { name: 'webkit-measurements' }] };\n`,
    );
    writeFileSync(
      playwrightTest,
      "import { test } from '@playwright/test'; test('pass', () => {}); test.skip('skip', () => {});\n",
    );
    execFileSync(
      "bin/pnpm",
      [
        "exec",
        "playwright",
        "test",
        "--config",
        playwrightConfig,
        "--reporter=json",
      ],
      {
        cwd: new URL("../..", import.meta.url),
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: playwrightReport },
        stdio: "ignore",
      },
    );
    const playwright = parsePlaywright(
      JSON.parse(readFileSync(playwrightReport)),
    );
    assert.equal(playwright.complete, true);
    assert.deepEqual(playwright.counts, {
      total: 4,
      passed: 2,
      failed: 0,
      skipped: 2,
    });
    assert.deepEqual(
      playwright.slowestTests
        .filter((entry) => entry.name === "pass")
        .map((entry) => entry.projectName)
        .sort(),
      ["chromium-measurements", "webkit-measurements"],
    );
    assert.ok(Number.isFinite(playwright.testDurationMs));
    assert.ok(playwright.slowestTests.length > 0);
    assert.ok(playwright.slowestFiles.length > 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
