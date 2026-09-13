import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import config from "../browser/playwright.config.mjs";
import { run } from "../browser/run-command.mjs";

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/ci.yml");
// These guards intentionally follow this workflow's small, literal job matrix.
// Unsupported YAML shapes fail rather than silently selecting fewer jobs.
const job = (name) => {
  const body = workflow.match(
    new RegExp(`^ {2}${name}:\n([\\s\\S]*?)(?=^ {2}\\w+:|$(?![\\s\\S]))`, "m"),
  )?.[1];
  assert.ok(body, `${name} job must exist`);
  return body;
};
const browser = job("browser");
const matrixValues = (key) => {
  const values = browser.match(
    new RegExp(`^ {8}${key}: \\[([^\\]]+)\\]$`, "m"),
  )?.[1];
  assert.ok(values, `literal ${key} matrix must exist`);
  return values.split(",").map((value) => value.trim());
};

test("four independent browser jobs retain isolated measurements and native setup", () => {
  assert.deepEqual(matrixValues("engine"), ["chromium", "webkit"]);
  assert.deepEqual(matrixValues("shard"), ["1", "2"]);
  assert.doesNotMatch(browser, /^ {4}(needs|if|continue-on-error):/m);
  assert.doesNotMatch(browser, /^ {8}(include|exclude):/m);
  assert.match(browser, /^ {6}fail-fast: false$/m);
  assert.match(
    browser,
    /name: browser-journeys-\$\{\{ matrix\.engine \}\}-\$\{\{ matrix\.shard \}\}/,
  );
  const preparation = browser.indexOf(
    "run: cargo build --locked -p buzzodz-plugins --example fixture-bridge",
  );
  const journey = browser.indexOf("run: pnpm test:browser:ci");
  assert.ok(
    preparation >= 0 && journey > preparation,
    "native fixture must build before the browser journeys",
  );
  // Setup must run on misses too, not merely when a cache is present.
  const step = browser.slice(
    browser.lastIndexOf("- name:", preparation),
    preparation,
  );
  assert.doesNotMatch(step, /\bif:/);
  assert.doesNotMatch(step, /continue-on-error/);
  const functional = browser
    .split("      - name: Functional journeys\n")[1]
    ?.split("      - name:")[0];
  assert.ok(functional, "functional step must exist");
  assert.doesNotMatch(functional, /^ {8}(if|continue-on-error):/m);
  assert.doesNotMatch(functional, /(?:\s|^)--list(?:[=\s]|$)/);
  assert.match(
    job("measurements"),
    /run: pnpm test:browser:ci --project '\*-measurements' --workers=1$/m,
  );
  assert.equal(config.workers, 2);
  assert.equal(config.retries, 0);
  assert.ok(!config.fullyParallel);
  const projects = Object.fromEntries(
    config.projects.map((project) => [project.name, project]),
  );
  assert.equal(projects["chromium-measurements"].workers, 1);
  assert.equal(projects["webkit-measurements"].workers, 1);
  assert.deepEqual(projects["webkit-measurements"].dependencies, [
    "chromium-measurements",
  ]);
  for (const engine of ["chromium", "webkit"])
    assert.deepEqual(projects[engine].dependencies, ["webkit-measurements"]);
});

test("workflow shards discover every functional test/project exactly once", (t) => {
  const command = browser.match(/^ {8}run: (pnpm test:browser:ci .+)$/m)?.[1];
  assert.ok(command, "functional invocation must exist");
  const discover = (args) => {
    const report = JSON.parse(
      run("pnpm", ["--silent", ...args, "--list", "--reporter=json"]),
    );
    assert.deepEqual(report.errors, []);
    const collect = (suites) =>
      suites.flatMap((suite) => [
        ...suite.specs.flatMap((spec) =>
          spec.tests.map((entry) => {
            assert.ok(
              ["chromium", "webkit"].includes(entry.projectName),
              "no measurements on functional runners",
            );
            return `${entry.projectName}:${spec.id}`;
          }),
        ),
        ...collect(suite.suites ?? []),
      ]);
    return collect(report.suites);
  };
  const expected = discover([
    "test:browser:ci",
    "--project",
    "chromium",
    "--project",
    "webkit",
    "--no-deps",
  ]);
  assert.ok(expected.length > 0);
  const actual = [];
  for (const engine of matrixValues("engine")) {
    for (const shard of matrixValues("shard")) {
      // Exercise the actual workflow command, including its shard denominator.
      const expanded = command
        .replaceAll(/\$\{\{ matrix\.engine \}\}/g, engine)
        .replaceAll(/\$\{\{ matrix\.shard \}\}/g, shard);
      const selected = discover(expanded.split(/\s+/).slice(1));
      assert.ok(selected.length > 0, `${engine}/${shard} must select tests`);
      assert.ok(selected.every((id) => id.startsWith(`${engine}:`)));
      actual.push(...selected);
      t.diagnostic(`${engine}/${shard}: ${selected.length} functional tests`);
    }
  }
  assert.equal(
    new Set(actual).size,
    actual.length,
    "no duplicate test/project across shards",
  );
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    "matrix must cover unsharded discovery",
  );
});

test("required gate executes its real shell and rejects every unsuccessful lane", () => {
  const required = job("required");
  assert.match(required, /^ {4}name: CI required$/m);
  assert.match(required, /^ {4}if: always\(\)$/m);
  assert.doesNotMatch(required, /^ {8}if:/m);
  assert.match(
    required,
    /^ {4}needs: \[javascript, native, windows-native, measurements, browser\]$/m,
  );
  assert.doesNotMatch(required, /continue-on-error/);
  const lanes = [
    "JAVASCRIPT",
    "NATIVE",
    "WINDOWS_NATIVE",
    "MEASUREMENTS",
    "BROWSER",
  ];
  for (const lane of lanes)
    assert.ok(
      required.includes(
        `${lane}: \${{ needs.${lane.toLowerCase().replaceAll("_", "-")}.result }}`,
      ),
    );
  const script = required.match(/^ {8}run: \|\n((?: {10}.+\n?)+)/m)?.[1];
  assert.ok(script, "required shell must exist");
  const execute = (results) =>
    spawnSync("bash", ["-e", "-c", script], {
      env: { PATH: process.env.PATH, ...results },
      encoding: "utf8",
      timeout: 5000,
    });
  const success = Object.fromEntries(lanes.map((lane) => [lane, "success"]));
  assert.equal(execute(success).status, 0);
  for (const lane of lanes) {
    for (const result of ["failure", "skipped", "cancelled", "", undefined]) {
      const results = { ...success, [lane]: result };
      if (result === undefined) delete results[lane];
      assert.equal(execute(results).status, 1, `${lane}=${result} must fail`);
    }
  }
});

test("Hermit cache keys distinguish jobs that provision different tools", () => {
  const setup = read(".github/actions/setup/action.yml");
  assert.match(setup, /key: hermit-.*\$\{\{ github\.job \}\}/);
});
