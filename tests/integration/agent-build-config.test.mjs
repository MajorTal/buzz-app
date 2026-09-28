import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Cargo rebuilds the real controller's nonsecret defaults from local config and explicit process overrides", (t) => {
  // Copy only source into an isolated workspace. Never replace a developer's
  // .env.local, share target output, launch an agent, or access real credentials.
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-build-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const crate = path.join(directory, "crates/agent-controller");
  mkdirSync(crate, { recursive: true });
  for (const entry of [
    "Cargo.toml",
    "build.rs",
    "build_config.rs",
    "src",
    "tests",
  ])
    cpSync(
      path.join(root, "crates/agent-controller", entry),
      path.join(crate, entry),
      { recursive: true },
    );
  // The controller's platform adapter has a sibling path dependency. Copy only
  // that crate's source too, preserving the fixture's isolated build outputs.
  for (const entry of ["Cargo.toml", "src"])
    cpSync(
      path.join(root, "crates/credential-store", entry),
      path.join(directory, "crates/credential-store", entry),
      { recursive: true },
    );
  cpSync(path.join(root, "runtime"), path.join(directory, "runtime"), {
    recursive: true,
  });
  // Cargo may prune the copied lock for this reduced workspace, offline only.
  cpSync(path.join(root, "Cargo.lock"), path.join(directory, "Cargo.lock"));
  writeFileSync(
    path.join(directory, "Cargo.toml"),
    '[workspace]\nmembers = ["crates/agent-controller"]\nresolver = "2"\n',
  );
  mkdirSync(path.join(crate, "examples"));
  writeFileSync(
    path.join(crate, "examples/defaults.rs"),
    'fn main() { println!("{}", serde_json::to_string(&buzz_agent_controller::build_defaults()).unwrap()); }',
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(BUZZ_|BUZZODZ_|NOSTR_|DATABRICKS_|CARGO_TARGET_DIR$)/.test(key),
    ),
  );
  env.CARGO_TARGET_DIR = path.join(directory, "target");
  const run = (overrides = {}, success = true) => {
    const result = spawnSync(
      path.join(root, "bin/cargo"),
      ["run", "--quiet", "--offline", "--example", "defaults"],
      {
        cwd: directory,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 300_000,
      },
    );
    assert.ifError(result.error);
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes("NEVER_PRINT_SECRET"),
    );
    if (!success) {
      assert.notEqual(result.status, 0);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const local = path.join(directory, ".env.local");
  const writeDefaults = (host) =>
    writeFileSync(
      local,
      `UNRELATED=bar baz\nBUZZ_BUILD_AGENT_ENV='DATABRICKS_HOST=https://${host}.example.com\nDATABRICKS_MODEL=build-model\nDATABRICKS_MODEL_FILTER=team-*'\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=false\nUNRELATED_SECRET=NEVER_PRINT_SECRET\n`,
    );
  writeDefaults("first");
  const expected = {
    host: "https://first.example.com",
    filter: "team-*",
    model: "build-model",
    provider: "databricks_v2",
    ownerOnly: true,
  };
  assert.deepEqual(run(), expected);
  // A comment marker inside backtick framing must not swallow real defaults
  // before a later literal backtick, or reject a genuinely closed value at EOF.
  for (const suffix of ["", "AFTER=prefix`literal\n"]) {
    writeFileSync(
      local,
      "OTHER=`note # literal`\nBUZZ_BUILD_AGENT_ENV='DATABRICKS_MODEL=following-model'\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n" +
        suffix,
    );
    assert.deepEqual(run(), {
      host: "",
      filter: "",
      model: "following-model",
      provider: "databricks_v2",
      ownerOnly: true,
    });
  }
  writeDefaults("first");
  // The entire controller suite must also work with documented file defaults,
  // rather than assuming developers build with an empty native configuration.
  const tests = spawnSync(
    path.join(root, "bin/cargo"),
    ["test", "--quiet", "--offline"],
    {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 300_000,
    },
  );
  assert.ifError(tests.error);
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  for (const value of [
    '"first""second\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n"',
    'prefix"second\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n"',
    'foo\\ #"more\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n"',
  ]) {
    writeFileSync(
      local,
      `OTHER=${value}\nUNRELATED=bar baz\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\n`,
    );
    assert.deepEqual(
      run(),
      {
        host: "",
        filter: "",
        model: "",
        provider: "databricks_v2",
        ownerOnly: false,
      },
      "embedded policy text must not become a compiled setting",
    );
  }
  writeFileSync(
    local,
    "OTHER=prefix`literal\nBUZZ_BUILD_AGENT_ENV='DATABRICKS_MODEL=following-model'\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n",
  );
  assert.deepEqual(run(), {
    host: "",
    filter: "",
    model: "following-model",
    provider: "databricks_v2",
    ownerOnly: true,
  });
  writeFileSync(
    local,
    "OTHER=`multiline\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n`\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\n",
  );
  assert.deepEqual(run(), {
    host: "",
    filter: "",
    model: "",
    provider: "databricks_v2",
    ownerOnly: false,
  });
  writeFileSync(
    local,
    "OTHER=`NEVER_PRINT_SECRET\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n",
  );
  run({}, false);
  writeDefaults("changed");
  expected.host = "https://changed.example.com";
  assert.deepEqual(
    run(),
    expected,
    "a warm Cargo build must notice changed .env.local",
  );
  assert.deepEqual(
    run({
      BUZZ_BUILD_AGENT_ENV: "DATABRICKS_MODEL=ci-model",
      BUZZ_BUILD_BUZZ_AGENT_PROVIDER: "ci-provider",
    }),
    {
      ...expected,
      host: "",
      filter: "",
      model: "ci-model",
      provider: "ci-provider",
    },
  );
  assert.deepEqual(
    run({ BUZZ_BUILD_AGENT_ENV: "", BUZZ_BUILD_BUZZ_AGENT_PROVIDER: "" }),
    { ...expected, host: "", filter: "", model: "", provider: "" },
  );
  writeFileSync(
    local,
    "BUZZ_BUILD_AGENT_ENV=DATABRICKS_TOKEN=NEVER_PRINT_SECRET\n",
  );
  run({}, false);
  rmSync(local);
  assert.deepEqual(
    run(),
    { host: "", filter: "", model: "", provider: "", ownerOnly: false },
    "removing local/process inputs must clear a warm build",
  );
});
