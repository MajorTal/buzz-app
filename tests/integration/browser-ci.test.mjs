import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { imageEngines } from "../../scripts/check-browser-image.mjs";
import { verifiedFixture, nativeFixture } from "../browser/native-fixture.mjs";
import { createHash } from "node:crypto";
import ciConfig from "../browser/playwright.ci.config.mjs";
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

test("twelve browser jobs retain isolated measurements and one required native build", () => {
  assert.deepEqual(matrixValues("engine"), ["chromium", "webkit"]);
  assert.deepEqual(matrixValues("shard"), ["1", "2", "3", "4", "5", "6"]);
  assert.match(browser, /^ {4}needs: \[browser_fixture\]$/m);
  assert.doesNotMatch(browser, /^ {4}continue-on-error:/m);
  assert.doesNotMatch(browser, /^ {8}(include|exclude):/m);
  assert.match(browser, /^ {6}fail-fast: false$/m);
  assert.match(
    browser,
    /name: browser-journeys-\$\{\{ matrix\.engine \}\}-\$\{\{ matrix\.shard \}\}/,
  );
  const preparation = browser.indexOf("name: Verify native browser fixture");
  const journey = browser.indexOf("-- ./bin/pnpm test:browser:ci");
  assert.ok(
    preparation >= 0 && journey > preparation,
    "same-revision native fixture must verify before journeys",
  );
  assert.doesNotMatch(browser, /apt-get|rustup|run: (?:\.\/bin\/)?cargo/);
  const functional = browser
    .split("      - name: Functional journeys\n")[1]
    ?.split("      - name:")[0];
  assert.ok(functional, "functional step must exist");
  assert.doesNotMatch(functional, /^ {8}(if|continue-on-error):/m);
  assert.doesNotMatch(functional, /(?:\s|^)--list(?:[=\s]|$)/);
  assert.match(functional, /--reporter=list,json/);
  assert.match(
    job("measurements"),
    /-- \.\/bin\/pnpm test:browser:ci --project '\*-measurements' --workers=1 --reporter=list,json$/m,
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

test("one same-run native artifact preserves the executable, revision and test-owned homes", (t) => {
  const { jobs } = parse(workflow),
    build = jobs.browser_fixture,
    steps = jobs.browser.steps;
  assert.equal(build["runs-on"], "ubuntu-24.04");
  assert.equal(build.container, undefined);
  assert.equal(build["timeout-minutes"], 15);
  const compile = build.steps.find(
    (step) => step.name === "Build native browser fixture",
  );
  assert.equal(
    compile.run,
    "./bin/cargo build --locked -p buzzodz-plugins --example fixture-bridge --target-dir target/browser-fixture",
  );
  assert.equal(compile.if, undefined);
  assert.equal(compile["continue-on-error"], undefined);
  const upload = build.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  const download = steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.equal(
    upload.with.name,
    `browser-fixture-\${{ github.sha }}-\${{ github.run_attempt }}`,
  );
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.id, "fixture-upload");
  assert.equal(
    build.outputs["artifact-id"],
    `\${{ steps.fixture-upload.outputs.artifact-id }}`,
  );
  assert.equal(
    download.with["artifact-ids"],
    `\${{ needs.browser_fixture.outputs.artifact-id }}`,
  );
  assert.equal(download.with["merge-multiple"], true);
  assert.equal(download.with.name, undefined);
  assert.equal(download.with["run-id"], undefined);
  assert.equal(download.with["github-token"], undefined);
  assert.equal(download.with.path, jobs.browser.env.BUZZ_BROWSER_FIXTURE_DIR);
  const verify = steps.find(
    (step) => step.name === "Verify native browser fixture",
  );
  assert.equal(verify.if, undefined);
  assert.equal(verify["continue-on-error"], undefined);
  const cwd = mkdtempSync(join(tmpdir(), "buzz-fixture-artifact-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const binary = join(cwd, "fixture-bridge"),
    revision = "a".repeat(40);
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(cwd, "revision"), `${revision}\n`);
  const checksum = () =>
    createHash("sha256").update(readFileSync(binary)).digest("hex");
  writeFileSync(join(cwd, "SHA256SUMS"), `${checksum()}  fixture-bridge\n`);
  assert.equal(verifiedFixture(cwd, revision), binary);
  assert.throws(
    () => verifiedFixture(cwd, "b".repeat(40)),
    "wrong revision fails",
  );
  chmodSync(binary, 0o644);
  assert.throws(
    () => verifiedFixture(cwd, revision),
    "non-executable artifact fails",
  );
  chmodSync(binary, 0o755);
  writeFileSync(binary, "changed");
  assert.throws(() => verifiedFixture(cwd, revision), "altered binary fails");
  rmSync(binary);
  assert.throws(() => verifiedFixture(cwd, revision), "missing artifact fails");
  const ci = process.env.CI,
    directory = process.env.BUZZ_BROWSER_FIXTURE_DIR;
  try {
    process.env.CI = "true";
    delete process.env.BUZZ_BROWSER_FIXTURE_DIR;
    assert.throws(
      () => nativeFixture(),
      /must supply/,
      "CI cannot silently rebuild missing evidence",
    );
  } finally {
    if (ci === undefined) delete process.env.CI;
    else process.env.CI = ci;
    if (directory === undefined) delete process.env.BUZZ_BROWSER_FIXTURE_DIR;
    else process.env.BUZZ_BROWSER_FIXTURE_DIR = directory;
  }
});

test("workflow shards discover every functional test/project exactly once", (t) => {
  const command = browser.match(
    /^ {8}run: .+ -- (\.\/bin\/pnpm test:browser:ci .+)$/m,
  )?.[1];
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
      const selected = discover(
        expanded.replace(/^\.\/bin\/pnpm /, "").split(/\s+/),
      );
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

test("classic-scrollbar cases run exactly once, after the measurements, without clearing their evidence", () => {
  const { steps } = parse(workflow).jobs.measurements;
  const serial = steps.findIndex(
    (step) => step.name === "Serial Chromium and WebKit measurements",
  );
  const classic = steps.find(
    (step) => step.name === "Chromium classic-scrollbar layout",
  );
  assert.ok(serial >= 0 && classic, "both Playwright steps must exist");
  assert.ok(steps.indexOf(classic) > serial, "classic cases run afterwards");
  assert.equal(classic.if, undefined);
  assert.equal(classic["continue-on-error"], undefined);
  const command = classic.run.match(
    /^\.\/bin\/node scripts\/ci-test-report\.mjs kind=playwright report=(\S+) evidence=(\S+) title="[^"]+" -- (\.\/bin\/pnpm test:browser:ci --project chromium-classic-scrollbars --no-deps --reporter=list,json)$/,
  );
  assert.ok(command, "classic step must report through ci-test-report");
  const [, report, evidence, invocation] = command;
  assert.equal(classic.env.PLAYWRIGHT_JSON_OUTPUT_FILE, report);
  // A Playwright run clears the outputDir of every project it selects. The
  // second run must therefore own a directory the measurement report and the
  // per-test evidence never live in, and the artifact must upload both. The
  // step runs the CI config, so resolve the project there and require the
  // local config to agree: a CI-only override of the launch arguments or the
  // output directory would otherwise pass this gate unnoticed.
  const classicProject = (candidate) =>
    candidate.name === "chromium-classic-scrollbars";
  const project = ciConfig.projects.find(classicProject);
  assert.ok(project, "chromium-classic-scrollbars project must exist in CI");
  assert.deepEqual(
    project,
    config.projects.find(classicProject),
    "CI must run the classic project exactly as the local gate defines it",
  );
  assert.equal(ciConfig.outputDir, config.outputDir);
  assert.equal(project.use.browserName, "chromium");
  assert.deepEqual(project.use.launchOptions.ignoreDefaultArgs, [
    "--hide-scrollbars",
  ]);
  const outputDir = (dir) => posix.normalize(posix.join("tests/browser", dir));
  const measurementDir = outputDir(ciConfig.outputDir);
  const classicDir = outputDir(project.outputDir);
  assert.notEqual(classicDir, measurementDir);
  assert.ok(!classicDir.startsWith(`${measurementDir}/`));
  assert.ok(!measurementDir.startsWith(`${classicDir}/`));
  assert.ok(
    steps[serial].env.PLAYWRIGHT_JSON_OUTPUT_FILE.startsWith(
      `${measurementDir}/`,
    ),
  );
  for (const path of [report, evidence])
    assert.ok(
      path.startsWith(`${classicDir}/`),
      `${path} stays in its own dir`,
    );
  const upload = steps.find((step) => step.name === "Measurement evidence");
  assert.deepEqual(
    upload.with.path
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .sort(),
    [measurementDir, classicDir].sort(),
  );
  // The tagged cases belong to this project alone: the engine shards above
  // exclude the tag, and this project selects nothing else.
  const list = (args) => {
    const listed = JSON.parse(
      run("pnpm", ["--silent", ...args, "--list", "--reporter=json"]),
    );
    assert.deepEqual(listed.errors, []);
    const collect = (suites) =>
      suites.flatMap((suite) => [
        ...(suite.specs ?? []),
        ...collect(suite.suites ?? []),
      ]);
    return collect(listed.suites);
  };
  const selected = list(invocation.replace(/^\.\/bin\/pnpm /, "").split(/\s+/));
  assert.ok(selected.length > 0, "the classic project must select tests");
  for (const spec of selected) {
    assert.ok(spec.tags.includes("classic-scrollbars"), spec.title);
    for (const entry of spec.tests)
      assert.equal(entry.projectName, "chromium-classic-scrollbars");
  }
  const functional = list([
    "test:browser:ci",
    "--project",
    "chromium",
    "--project",
    "webkit",
    "--no-deps",
  ]);
  assert.ok(functional.length > 0);
  for (const spec of functional)
    assert.ok(!spec.tags.includes("classic-scrollbars"), spec.title);
});

test("automatic CI stays on Linux and manual dispatch runs only Windows", () => {
  const { jobs } = parse(workflow);
  for (const lane of [
    "javascript",
    "native",
    "measurements",
    "browser_fixture",
    "browser",
  ]) {
    assert.equal(jobs[lane].if, "github.event_name != 'workflow_dispatch'");
    assert.equal(jobs[lane]["runs-on"], "ubuntu-24.04");
  }
  const windows = jobs["windows-native"];
  assert.equal(windows.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(windows["runs-on"], "windows-2025");
  const packages =
    "-p buzz-foundation -p buzz-agent-controller -p buzz-credential-store";
  assert.ok(
    windows.steps.some(
      (step) => step.run === `cargo test ${packages} --locked --no-fail-fast`,
    ),
    "on-demand Windows validation retains complete tests for all native identity packages",
  );
  assert.ok(
    windows.steps.some(
      (step) =>
        step.run ===
        `cargo clippy ${packages} --locked --all-targets -- -D warnings`,
    ),
    "Windows lint covers production and test targets without suppressing warnings",
  );
});

test("required gate executes its real shell and rejects every unsuccessful lane", () => {
  const required = job("required");
  const { jobs } = parse(workflow);
  assert.equal(
    jobs.required.name,
    `\${{ github.event_name == 'workflow_dispatch' && 'Automatic CI (not requested)' || 'CI required' }}`,
  );
  assert.equal(
    jobs.required.if,
    "always() && github.event_name != 'workflow_dispatch'",
  );
  assert.doesNotMatch(required, /^ {8}if:/m);
  assert.match(
    required,
    /^ {4}needs: \[javascript, native, measurements, browser_fixture, browser\]$/m,
  );
  assert.doesNotMatch(required, /continue-on-error/);
  const lanes = ["JAVASCRIPT", "NATIVE", "MEASUREMENTS", "FIXTURE", "BROWSER"];
  for (const lane of lanes)
    assert.ok(
      required.includes(
        `${lane}: \${{ needs.${lane === "FIXTURE" ? "browser_fixture" : lane.toLowerCase()}.result }}`,
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

test("browser jobs use one immutable image matching the package pin, without per-job browser downloads", () => {
  const { jobs } = parse(workflow);
  const setup = parse(read(".github/actions/setup/action.yml"));
  const version = JSON.parse(read("package.json")).devDependencies[
    "@playwright/test"
  ];
  const image = `mcr.microsoft.com/playwright:v${version}-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`;
  for (const name of ["measurements", "browser"]) {
    const job = jobs[name];
    assert.doesNotMatch(
      job.steps.map((step) => step.run ?? "").join("\n"),
      /apt-get|playwright install|(?:^|\n)(?:\.\/bin\/)?cargo/,
    );
    assert.equal(job.container.image, image);
    assert.equal(job.container.options, "--init --ipc=host");
    assert.equal(job.defaults.run.shell, "bash");
    assert.equal(job.env.HOME, "/root");
    const trust = job.steps.find(
      (step) => step.name === "Trust this container workspace",
    );
    assert.equal(
      trust.run,
      'git config --global --add safe.directory "$GITHUB_WORKSPACE"',
    );
    assert.ok(
      job.steps.indexOf(trust) <
        job.steps.findIndex((step) => step.uses === "./.github/actions/setup"),
    );
    assert.equal(trust.if, undefined);
    assert.equal(trust["continue-on-error"], undefined);
    assert.equal(job["timeout-minutes"], 15);
    assert.equal(
      job.steps.find((step) => step.uses === "./.github/actions/setup").with
        .browsers,
      "true",
    );
  }
  for (const name of ["javascript", "native", "windows-native"])
    assert.equal(jobs[name].container, undefined);
  assert.equal(setup.inputs["browser-engine"].default, "all");
  const configured = (name) =>
    jobs[name].steps.find((step) => step.uses === "./.github/actions/setup")
      .with;
  assert.equal(
    configured("browser")["browser-engine"],
    `\${{ matrix.engine }}`,
  );
  assert.equal(configured("measurements")["browser-engine"], undefined);
  const steps = setup.runs.steps,
    verify = steps.find((step) => step.name === "Verify pinned browser image");
  assert.equal(verify.if, "inputs.browsers == 'true'");
  assert.equal(verify["continue-on-error"], undefined);
  assert.equal(verify.run, "./bin/node scripts/check-browser-image.mjs");
  assert.equal(verify.env.PLAYWRIGHT_ENGINE, `\${{ inputs.browser-engine }}`);
  assert.ok(
    steps.indexOf(verify) >
      steps.findIndex(
        (step) => step.run === "./bin/pnpm install --frozen-lockfile",
      ),
  );
  assert.doesNotMatch(
    read(".github/actions/setup/action.yml"),
    /playwright install|apt-get|ms-playwright/,
  );
});

test("image verification rejects version/image mismatch and never silently omits an engine", () => {
  const version = JSON.parse(read("package.json")).devDependencies[
    "@playwright/test"
  ];
  const info = {
    driverVersion: version,
    dockerImageName: `mcr.microsoft.com/playwright:v${version}-noble`,
  };
  assert.deepEqual(imageEngines(info, version, "all"), ["chromium", "webkit"]);
  for (const engine of ["chromium", "webkit"])
    assert.deepEqual(imageEngines(info, version, engine), [engine]);
  for (const engine of [
    "",
    "firefox",
    "chromium webkit",
    "chromium;echo unexpected",
  ])
    assert.throws(() => imageEngines(info, version, engine));
  for (const bad of [
    {},
    { ...info, driverVersion: "0.0.0" },
    { ...info, dockerImageName: "untrusted/image" },
  ])
    assert.throws(() => imageEngines(bad, version, "all"));
});

test("setup calls pinned entry points and fails before caching an empty pnpm path", (t) => {
  const { steps } = parse(read(".github/actions/setup/action.yml")).runs;
  const verify = steps.find(
    (step) => step.name === "Verify pinned tool entry points",
  );
  const store = steps.find((step) => step.id === "pnpm");
  assert.ok(steps.indexOf(verify) < steps.indexOf(store));
  assert.match(verify.run, /\.\/bin\/node --version/);
  assert.match(verify.run, /\.\/bin\/pnpm --version/);
  assert.doesNotMatch(
    read(".github/actions/setup/action.yml"),
    /GITHUB_PATH|HERMIT_PREPEND_PATH/,
  );
  const cwd = mkdtempSync(join(tmpdir(), "buzz-pnpm-path-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "bin"));
  writeFileSync(
    join(cwd, "bin", "pnpm"),
    '#!/bin/sh\n[ "$1 $2 $3" = "store path --silent" ] || exit 2\nprintf "%s" "$STORE"\nexit "$RESULT"\n',
    { mode: 0o755 },
  );
  const output = join(cwd, "output");
  const execute = (path, result = "0") => {
    writeFileSync(output, "");
    return spawnSync("bash", ["-eo", "pipefail", "-c", store.run], {
      cwd,
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        STORE: path,
        RESULT: result,
      },
      encoding: "utf8",
      timeout: 5000,
    });
  };
  assert.equal(execute("/pinned store").status, 0);
  assert.equal(readFileSync(output, "utf8"), "path=/pinned store\n");
  assert.notEqual(execute("").status, 0);
  assert.equal(readFileSync(output, "utf8"), "");
  assert.equal(execute("", "7").status, 7);
  assert.equal(readFileSync(output, "utf8"), "");
});
