// Verify extracted Windows/Linux payloads, never launch their executables.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";

const [directory, target] = process.argv.slice(2);
assert.ok(
  directory && target,
  "Usage: verify-runtime-bundle.mjs <directory> <target>",
);
const source = JSON.parse(
  readFileSync(
    new URL("../runtime/agent-runtime.json", import.meta.url),
    "utf8",
  ),
);
const manifest = JSON.parse(
  readFileSync(join(directory, "manifest.json"), "utf8"),
);
assert.deepEqual(Object.keys(manifest).sort(), [
  "files",
  "goose",
  "revision",
  "target",
  "version",
]);
assert.equal(manifest.version, 2);
assert.deepEqual(manifest.goose, source.goose);
assert.equal(manifest.revision, source.revision);
assert.equal(manifest.target, target);
const windows = target.endsWith("-windows-msvc");
const names = source.tools.map((name) => (windows ? `${name}.exe` : name));
assert.deepEqual(Object.keys(manifest.files).sort(), names.sort());
for (const name of names) {
  const file = join(directory, name);
  const stat = lstatSync(file);
  assert.ok(stat.isFile(), `${name} must be a regular file`);
  if (!windows) assert.ok(stat.mode & 0o111, `${name} must be executable`);
  assert.equal(
    createHash("sha256").update(readFileSync(file)).digest("hex"),
    manifest.files[name],
    `${name} hash changed during packaging`,
  );
}
console.log(`Verified packaged runtime (${manifest.revision}, ${target})`);
