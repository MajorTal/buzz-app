import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const finite = (value, label) => {
  if (!Number.isFinite(value)) throw new Error(`invalid ${label}`);
  return value;
};
const cleanPath = (path) => {
  const local = relative(process.cwd(), path);
  return local && !local.startsWith("..") ? local : path;
};
const slowest = (costs) =>
  costs.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);

export function parseVitest(report) {
  if (!Array.isArray(report.testResults))
    throw new Error("invalid testResults");
  const counts = {
    total: finite(report.numTotalTests, "total test count"),
    passed: finite(report.numPassedTests, "passed test count"),
    failed: finite(report.numFailedTests, "failed test count"),
    skipped:
      finite(report.numPendingTests, "pending test count") +
      finite(report.numTodoTests, "todo test count"),
  };
  const tests = [];
  const files = [];
  for (const file of report.testResults) {
    const path = cleanPath(file.name);
    files.push({
      file: path,
      durationMs: Math.max(
        0,
        finite(file.endTime - file.startTime, "file duration"),
      ),
    });
    for (const result of file.assertionResults ?? []) {
      if (Number.isFinite(result.duration))
        tests.push({
          name: result.fullName,
          file: path,
          durationMs: result.duration,
        });
    }
  }
  return {
    complete: report.success === true && counts.failed === 0,
    counts,
    testDurationMs: tests.reduce((sum, test) => sum + test.durationMs, 0),
    fileDurationBasis: "Elapsed per file (may overlap)",
    slowestTests: slowest(tests),
    slowestFiles: slowest(files),
  };
}

const playwrightSpecs = (suites) =>
  suites.flatMap((suite) => [
    ...(suite.specs ?? []),
    ...playwrightSpecs(suite.suites ?? []),
  ]);

export function parsePlaywright(report) {
  const stats = report.stats;
  if (!stats || !Array.isArray(report.suites) || !Array.isArray(report.errors))
    throw new Error("invalid Playwright report");
  const counts = {
    total:
      finite(stats.expected, "expected test count") +
      finite(stats.unexpected, "unexpected test count") +
      finite(stats.flaky, "flaky test count") +
      finite(stats.skipped, "skipped test count"),
    passed: stats.expected + stats.flaky,
    failed: stats.unexpected,
    skipped: stats.skipped,
  };
  const tests = [];
  const fileCosts = new Map();
  for (const spec of playwrightSpecs(report.suites)) {
    for (const entry of spec.tests ?? []) {
      const durationMs = (entry.results ?? []).reduce(
        (sum, result) => sum + finite(result.duration, "test duration"),
        0,
      );
      tests.push({ name: spec.title, file: spec.file, durationMs });
      fileCosts.set(spec.file, (fileCosts.get(spec.file) ?? 0) + durationMs);
    }
  }
  return {
    complete: report.errors.length === 0 && counts.failed === 0,
    counts,
    testDurationMs: tests.reduce((sum, test) => sum + test.durationMs, 0),
    fileDurationBasis: "Summed test execution per file",
    slowestTests: slowest(tests),
    slowestFiles: slowest(
      [...fileCosts].map(([file, durationMs]) => ({ file, durationMs })),
    ),
  };
}

const duration = (milliseconds) => {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
};
const escapeCell = (value) =>
  String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll(/\s+/g, " ");

export function formatSummary(title, report, elapsedMs, error) {
  const lines = [`## ${escapeCell(title)}`, ""];
  if (!report) {
    lines.push(
      `> **Report unavailable:** ${escapeCell(error)}. This result is incomplete, not green.`,
      "",
      `Elapsed wall time: **${duration(elapsedMs)}**`,
      "",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "| Metric | Value |",
    "| --- | ---: |",
    `| Status | ${report.complete ? "Complete" : "Incomplete or failed"} |`,
    `| Tests | ${report.counts.total} |`,
    `| Passed | ${report.counts.passed} |`,
    `| Failed | ${report.counts.failed} |`,
    `| Skipped/todo | ${report.counts.skipped} |`,
    `| Elapsed wall time | ${duration(elapsedMs)} |`,
    `| Summed test execution time | ${duration(report.testDurationMs)} |`,
    "",
  );
  const costTable = (heading, costs, basis = "Execution time") => {
    if (costs.length === 0) return;
    lines.push(
      `### ${heading}`,
      "",
      `| Test/file | File | ${basis} |`,
      "| --- | --- | ---: |",
      ...costs.map(
        (cost) =>
          `| ${escapeCell(cost.name ?? cost.file)} | ${escapeCell(cost.name ? cost.file : "—")} | ${duration(cost.durationMs)} |`,
      ),
      "",
    );
  };
  costTable("Slowest tests", report.slowestTests);
  costTable("Slowest files", report.slowestFiles, report.fileDurationBasis);
  return `${lines.join("\n")}\n`;
}

function main() {
  const separator = process.argv.indexOf("--");
  const options = Object.fromEntries(
    process.argv
      .slice(2, separator)
      .map((argument) => argument.split(/=(.*)/s).slice(0, 2)),
  );
  const command = process.argv.slice(separator + 1);
  if (
    separator < 0 ||
    !["vitest", "playwright"].includes(options.kind) ||
    !options.report ||
    !options.evidence ||
    !options.title ||
    command.length === 0
  )
    throw new Error(
      "usage: ci-test-report kind=<vitest|playwright> report=<path> evidence=<path> title=<title> -- <command>",
    );

  mkdirSync(dirname(options.report), { recursive: true });
  rmSync(options.report, { force: true });
  const started = performance.now();
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  const elapsedMs = performance.now() - started;
  let report;
  let reportError;
  try {
    const source = JSON.parse(readFileSync(options.report, "utf8"));
    report =
      options.kind === "vitest" ? parseVitest(source) : parsePlaywright(source);
    report.complete = report.complete && result.status === 0;
  } catch (error) {
    reportError = error instanceof Error ? error.message : String(error);
  }
  const evidence = {
    schemaVersion: 1,
    runner: options.kind,
    elapsedWallTimeMs: elapsedMs,
    report: report ?? null,
    reportError: reportError ?? null,
  };
  mkdirSync(dirname(options.evidence), { recursive: true });
  writeFileSync(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
  const summary = formatSummary(options.title, report, elapsedMs, reportError);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);

  if (result.error) throw result.error;
  process.exitCode =
    result.status === 0 ? (report?.complete ? 0 : 1) : (result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
