import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { runtimeBuildPlatform } from "../../scripts/runtime-build-platform.mjs";

const root = new URL("../../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "buzz-packaging-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Windows uses provisioned executables without corrupting Path or retaining credentials", () => {
  const inherited = {
    Path: "C:\\tools;C:\\Windows",
    SystemRoot: "C:\\Windows",
    RUSTUP_TOOLCHAIN: "1.97.1",
    buzz_private_key: "secret",
    BuzzODZ_PROFILE: "private",
    Nostr_KEY: "secret",
    Databricks_TOKEN: "secret",
    Cargo_Target_Dir: "old",
    Cargo_Build_Target: "other-target",
    Cargo_Encoded_Rustflags: "-Copt-level=0",
    Cargo_Profile_Release_Opt_Level: "0",
    Rustc: "other-rustc",
    Rustc_Wrapper: "sccache",
    Rustflags: "-C target-cpu=native",
    Rustdocflags: "--cfg other",
  };
  const { env, cargo, rustc } = runtimeBuildPlatform(
    "C:\\repo",
    "win32",
    inherited,
  );
  assert.equal(cargo, "cargo.exe");
  assert.equal(rustc, "rustc.exe");
  assert.deepEqual(env, {
    Path: inherited.Path,
    SystemRoot: inherited.SystemRoot,
    RUSTUP_TOOLCHAIN: inherited.RUSTUP_TOOLCHAIN,
    CARGO_TARGET_DIR: "C:\\repo\\target\\agent-runtime-build",
  });
  assert.equal(
    inherited.buzz_private_key,
    "secret",
    "must not mutate parent environment",
  );
  const posix = runtimeBuildPlatform("/repo", "linux", {
    PATH: "/usr/bin",
    CARGO_TARGET_DIR: "old",
    BUZZ_PRIVATE_KEY: "secret",
  });
  assert.equal(posix.cargo, "/repo/bin/cargo");
  assert.equal(posix.rustc, "/repo/bin/rustc");
  assert.deepEqual(posix.env, {
    PATH: "/repo/bin:/usr/bin",
    CARGO_TARGET_DIR: "/repo/target/agent-runtime-build",
  });
});

test("candidate version writes an updater-disabled overlay, never changes product identity", (t) => {
  const directory = temporary(t);
  const output = join(directory, "env");
  const result = spawnSync(
    process.execPath,
    ["scripts/candidate-version.mjs"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        GITHUB_ENV: output,
        GITHUB_RUN_NUMBER: "42",
        GITHUB_RUN_ATTEMPT: "2",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(join(directory, "candidate.json"))),
    {
      version: "0.0.0-preview.42.2",
      bundle: { createUpdaterArtifacts: false },
    },
  );
  assert.equal(readFileSync(output, "utf8"), "VERSION=0.0.0-preview.42.2\n");
});

for (const target of ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]) {
  test(`packaged runtime verification rejects transformed or missing payloads: ${target}`, (t) => {
    const directory = temporary(t);
    const spec = JSON.parse(read("runtime/agent-runtime.json"));
    const files = {};
    for (const tool of spec.tools) {
      const name = target.endsWith("-msvc") ? `${tool}.exe` : tool;
      writeFileSync(join(directory, name), tool, { mode: 0o755 });
      files[name] = createHash("sha256").update(tool).digest("hex");
    }
    const manifest = {
      version: 2,
      revision: spec.revision,
      goose: spec.goose,
      target,
      files,
    };
    const save = () =>
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    const run = () =>
      spawnSync(
        process.execPath,
        ["scripts/verify-runtime-bundle.mjs", directory, target],
        { cwd: root, encoding: "utf8" },
      );
    save();
    assert.equal(run().status, 0);
    const name = Object.keys(files)[0];
    writeFileSync(join(directory, name), "bundler transformed bytes");
    assert.notEqual(run().status, 0);
    writeFileSync(join(directory, name), spec.tools[0], { mode: 0o755 });
    assert.equal(run().status, 0);
    manifest.revision = "0".repeat(40);
    save();
    assert.notEqual(run().status, 0);
    manifest.revision = spec.revision;
    manifest.target = "wrong";
    save();
    assert.notEqual(run().status, 0);
    manifest.target = target;
    save();
    rmSync(join(directory, name));
    assert.notEqual(run().status, 0);
  });
}

test("candidate builds cannot reach publisher or macOS signing and use read-only tokens", () => {
  const workflow = parse(read(".github/workflows/release.yml"));
  assert.equal(workflow.on.workflow_dispatch.inputs.candidates.default, false);
  assert.equal(workflow.permissions.contents, "read");
  assert.match(workflow.jobs.build.if, /!inputs\.candidates/);
  assert.equal(workflow.jobs.publish.needs, "build");
  assert.equal(
    workflow.jobs.publish.if,
    undefined,
    "default success dependency must skip publisher when macOS is skipped",
  );
  for (const platform of ["windows", "linux"]) {
    const job = workflow.jobs[platform];
    assert.equal(
      job.if,
      "github.repository == 'block/buzz-app' && inputs.candidates",
    );
    assert.equal(job.permissions, undefined);
    assert.ok(
      job.steps.some((step) => step.run?.includes("verify-runtime-bundle.mjs")),
    );
    assert.ok(
      job.steps.some((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      ),
    );
    assert.ok(!JSON.stringify(job).includes("secrets."));
  }
});
