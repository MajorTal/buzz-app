import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./run-command.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** CI consumes a same-run immutable build; each test still supplies its own home. */
export function verifiedFixture(directory, revision) {
  assert.equal(
    readFileSync(join(directory, "revision"), "utf8").trim(),
    revision,
  );
  const binary = join(directory, "fixture-bridge");
  const checksum = readFileSync(join(directory, "SHA256SUMS"), "utf8").trim();
  assert.match(checksum, /^[a-f0-9]{64} {2}fixture-bridge$/);
  assert.equal(
    createHash("sha256").update(readFileSync(binary)).digest("hex"),
    checksum.slice(0, 64),
  );
  accessSync(binary, constants.X_OK);
  return binary;
}
export function nativeFixture() {
  const directory = process.env.BUZZ_BROWSER_FIXTURE_DIR;
  if (directory)
    return verifiedFixture(
      resolve(root, directory),
      run("git", ["rev-parse", "HEAD"]).trim(),
    );
  assert.ok(
    !process.env.CI,
    "CI must supply its verified native fixture; no download or build fallback",
  );
  run("cargo", [
    "build",
    "--locked",
    "-p",
    "buzzodz-plugins",
    "--example",
    "fixture-bridge",
  ]);
  const metadata = JSON.parse(
    run("cargo", ["metadata", "--no-deps", "--format-version=1"]),
  );
  return join(metadata.target_directory, "debug/examples/fixture-bridge");
}
