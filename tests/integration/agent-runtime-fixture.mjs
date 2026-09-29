import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Real preparation script and manifest; only the compiler toolchain is synthetic.
export function runtimeFixture(directory) {
  for (const name of ["scripts", "runtime", "bin"])
    mkdirSync(path.join(directory, name), { recursive: true });
  for (const name of [
    "scripts/build-agent-runtime.mjs",
    "scripts/runtime-build-platform.mjs",
    "runtime/agent-runtime.json",
  ])
    copyFileSync(
      new URL(`../../${name}`, import.meta.url),
      path.join(directory, name),
    );
  const tool = (name, body) =>
    writeFileSync(
      path.join(directory, "bin", name),
      `#!${process.execPath}\n${body}\n`,
      { mode: 0o755 },
    );
  tool("rustc", 'console.log("host: fixture-target");');
  // Cargo runs inside the fetched source checkout, so fixture state is absolute.
  tool(
    "cargo",
    `
const fs = require("node:fs");
const path = require("node:path");
const fixture = ${JSON.stringify(directory)};
fs.appendFileSync(path.join(fixture, "build-calls.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
if (fs.existsSync(path.join(fixture, "fail-build"))) process.exit(17);
// Shell compiler overrides must not reach a build whose bundle other worktrees reuse.
if (["RUSTFLAGS", "RUSTC_WRAPPER", "CARGO_PROFILE_RELEASE_OPT_LEVEL"].some((key) => key in process.env)) process.exit(18);
// Lets a test run another worktree's preparation while this build is in flight.
const during = path.join(fixture, "during-build");
if (fs.existsSync(during)) require("node:child_process").execFileSync(process.execPath,
  ["scripts/build-agent-runtime.mjs"], { cwd: fs.readFileSync(during, "utf8"), stdio: "ignore" });
// Like Cargo, --target (or a user-level build.target) nests the output by triple.
const flag = process.argv.indexOf("--target");
const configured = path.join(fixture, "config-build-target");
const triple = flag >= 0 ? process.argv[flag + 1]
  : fs.existsSync(configured) ? fs.readFileSync(configured, "utf8") : "";
const output = path.join(process.env.CARGO_TARGET_DIR, triple, "release");
fs.mkdirSync(output, { recursive: true });
// Compilation progress that an interrupted build leaves for the next one.
const progress = path.join(process.env.CARGO_TARGET_DIR, "progress");
fs.appendFileSync(path.join(fixture, "resumed.jsonl"), JSON.stringify(fs.existsSync(progress)) + "\\n");
fs.writeFileSync(progress, "");
if (fs.existsSync(path.join(fixture, "interrupt-build"))) process.exit(130);
const spec = JSON.parse(fs.readFileSync(path.join(fixture, "runtime/agent-runtime.json"), "utf8"));
for (const name of spec.tools) fs.writeFileSync(path.join(output,
  process.platform === "win32" ? name + ".exe" : name), "fixture " + name + " " + fixture, { mode: 0o755 });
`,
  );
  // Source fetches succeed offline; a git-common-dir file opts into the shared cache.
  tool(
    "git",
    `
const fs = require("node:fs");
const path = require("node:path");
const common = path.join(${JSON.stringify(directory)}, "git-common-dir");
if (!process.argv.includes("rev-parse")) process.exit(0);
if (!fs.existsSync(common)) process.exit(128);
console.log(fs.readFileSync(common, "utf8"));
`,
  );
}
