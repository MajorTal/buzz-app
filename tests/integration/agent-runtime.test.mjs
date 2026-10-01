import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runtimeFixture } from "./agent-runtime-fixture.mjs";

test("native library and bundled tools pin the same immutable source", () => {
  const spec = JSON.parse(
    readFileSync(
      new URL("../../runtime/agent-runtime.json", import.meta.url),
      "utf8",
    ),
  );
  // Let Cargo parse its own manifest rather than duplicating TOML parsing here.
  const metadata = spawnSync(
    fileURLToPath(new URL("../../bin/cargo", import.meta.url)),
    ["metadata", "--format-version=1", "--no-deps", "--locked", "--offline"],
    {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.ifError(metadata.error);
  assert.equal(metadata.status, 0, metadata.stderr);
  const app = JSON.parse(metadata.stdout).packages.find(
    (pkg) => pkg.name === "buzz-foundation",
  );
  assert.ok(app, "native app package must be present");
  const agent = app.dependencies.find(
    (dependency) => dependency.name === "buzz-agent",
  );
  assert.ok(agent, "native app must declare its buzz-agent dependency");
  assert.match(spec.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    agent.source,
    `git+${spec.repository}?rev=${spec.revision}`,
    "Update src-tauri/Cargo.toml and runtime/agent-runtime.json together",
  );
});

test("runtime preparation builds missing resources, reuses verified files, and repairs stale or corrupt bundles", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtimeFixture(directory);
  const run = () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/build-agent-runtime.mjs"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const bundle = path.join(directory, "src-tauri/resources/agent-runtime");
  const manifestPath = path.join(bundle, "manifest.json");
  const count = () =>
    readFileSync(path.join(directory, "build-calls.jsonl"), "utf8")
      .trim()
      .split("\n").length;
  assert.match(run(), /Verified inputs staged/);
  assert.equal(count(), 2);
  assert.match(run(), /Agent runtime ready/);
  assert.equal(count(), 2, "warm preparation must not invoke Cargo");
  const filename =
    process.platform === "win32" ? "buzz-agent.exe" : "buzz-agent";
  const binary = path.join(bundle, filename);
  for (const mutation of [
    () => writeFileSync(binary, "corrupt"),
    () => rmSync(binary),
    () => writeFileSync(manifestPath, "not json"),
    () =>
      writeFileSync(
        manifestPath,
        " ".repeat(16385) + readFileSync(manifestPath, "utf8"),
      ),
    () => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.unexpected = true;
      writeFileSync(manifestPath, JSON.stringify(manifest));
    },
    ...["revision", "target", "version", "goose"].map((key) => () => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest[key] = "outdated";
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }),
    ...(process.platform === "win32" ? [] : [() => chmodSync(binary, 0o644)]),
  ]) {
    const before = count();
    mutation();
    assert.match(run(), /Verified inputs staged/);
    assert.equal(count(), before + 2);
    assert.ok(existsSync(binary));
    assert.match(run(), /Agent runtime ready/);
    assert.equal(count(), before + 2);
  }
});

test("runtime output ignores a user-level build target and survives an interrupted build", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtimeFixture(directory);
  // Even a build.target equal to the host must not move the output.
  writeFileSync(path.join(directory, "config-build-target"), "fixture-target");
  writeFileSync(path.join(directory, "interrupt-build"), "");
  const run = () =>
    spawnSync(process.execPath, ["scripts/build-agent-runtime.mjs"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
  assert.notEqual(run().status, 0);
  rmSync(path.join(directory, "interrupt-build"));
  const retry = run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /Verified inputs staged/);
  assert.deepEqual(
    readFileSync(path.join(directory, "resumed.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [false, true, true],
    "the retry reuses the interrupted build's target",
  );
});

test("worktrees of one clone reuse a verified runtime built from identical inputs", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const common = path.join(directory, "common");
  const worktrees = ["one", "two"].map((name) => {
    const root = path.join(directory, name);
    runtimeFixture(root);
    writeFileSync(path.join(root, "git-common-dir"), common);
    return root;
  });
  const run = (root) => {
    const result = spawnSync(
      process.execPath,
      ["scripts/build-agent-runtime.mjs"],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const built = (root) => existsSync(path.join(root, "build-calls.jsonl"));
  const [one, two] = worktrees;
  const bundle = (root) => path.join(root, "src-tauri/resources/agent-runtime");
  assert.match(run(one), /Verified inputs staged/);
  assert.match(run(two), /Verified inputs restored/);
  assert.ok(!built(two), "a matching cached runtime must not invoke Cargo");
  assert.deepEqual(
    readFileSync(path.join(bundle(two), "manifest.json"), "utf8"),
    readFileSync(path.join(bundle(one), "manifest.json"), "utf8"),
  );
  // A corrupt cache entry is rebuilt, never copied into a worktree.
  const [entry] = readdirSync(path.join(common, "buzz-agent-runtime"));
  writeFileSync(path.join(common, "buzz-agent-runtime", entry, "buzz"), "bad");
  rmSync(bundle(two), { recursive: true });
  assert.match(run(two), /Verified inputs staged/);
  assert.ok(built(two));
  rmSync(bundle(one), { recursive: true });
  assert.match(run(one), /Verified inputs restored/, "repair republishes");
  // Different pinned inputs use a different entry.
  const specPath = path.join(one, "runtime/agent-runtime.json");
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  writeFileSync(
    specPath,
    JSON.stringify({ ...spec, revision: "0".repeat(40) }),
  );
  assert.match(run(one), /Verified inputs staged/);
  assert.equal(readdirSync(path.join(common, "buzz-agent-runtime")).length, 2);
  writeFileSync(
    specPath,
    JSON.stringify({
      ...spec,
      goose: { ...spec.goose, revision: "1".repeat(40) },
    }),
  );
  assert.match(run(one), /Verified inputs staged/);
  assert.equal(readdirSync(path.join(common, "buzz-agent-runtime")).length, 3);
  assert.match(run(one), /Agent runtime ready/);
});

test("a build that finishes after a concurrent publish keeps the published entry", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const common = path.join(directory, "common");
  const [one, two] = ["one", "two"].map((name) => {
    const root = path.join(directory, name);
    runtimeFixture(root);
    writeFileSync(path.join(root, "git-common-dir"), common);
    return root;
  });
  // While two compiles, one builds and publishes the same key.
  writeFileSync(path.join(two, "during-build"), one);
  const result = spawnSync(
    process.execPath,
    ["scripts/build-agent-runtime.mjs"],
    {
      cwd: two,
      encoding: "utf8",
      timeout: 10_000,
      // Per-shell compiler overrides are scrubbed, so the fixture Cargo succeeds.
      env: {
        ...process.env,
        RUSTFLAGS: "-C target-cpu=native",
        RUSTC_WRAPPER: "sccache",
        CARGO_PROFILE_RELEASE_OPT_LEVEL: "0",
      },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const entries = path.join(common, "buzz-agent-runtime");
  assert.equal(readdirSync(entries).length, 1, "no leftover staging entries");
  const [entry] = readdirSync(entries);
  const tool = (dir) => readFileSync(path.join(dir, "buzz"), "utf8");
  assert.ok(
    tool(path.join(entries, entry)).endsWith(one),
    "first publish wins",
  );
  assert.ok(
    tool(path.join(two, "src-tauri/resources/agent-runtime")).endsWith(two),
  );
});

test("packaged desktop build prepares runtime before frontend compilation", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    config.build.beforeBuildCommand,
    "node scripts/build-agent-runtime.mjs && pnpm build",
  );
});
