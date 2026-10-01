import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// Execute the production repair script. Only AppImage extraction/repacking is
// synthetic: this proves byte restoration and failure gates, not ELF/GUI behavior.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "buzz-appimage-repair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["scripts", "runtime", "tools"])
    mkdirSync(join(root, name));
  for (const name of [
    "scripts/fix-appimage.sh",
    "scripts/verify-runtime-bundle.mjs",
    "runtime/agent-runtime.json",
  ])
    copyFileSync(new URL(`../../${name}`, import.meta.url), join(root, name));
  const source = join(root, "src-tauri/resources/agent-runtime");
  mkdirSync(source, { recursive: true });
  const spec = JSON.parse(
    readFileSync(join(root, "runtime/agent-runtime.json")),
  );
  const files = {};
  for (const name of spec.tools) {
    writeFileSync(join(source, name), `original ${name}`, { mode: 0o755 });
    files[name] = createHash("sha256").update(`original ${name}`).digest("hex");
  }
  writeFileSync(
    join(source, "manifest.json"),
    JSON.stringify({
      version: 2,
      revision: spec.revision,
      goose: spec.goose,
      target: "x86_64-unknown-linux-gnu",
      files,
    }),
  );
  const extracted = join(root, "extracted");
  const resource = "usr/lib/Buzz Foundation/agent-runtime";
  const destination = join(extracted, resource);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
  writeFileSync(join(destination, "buzz-agent"), "linuxdeploy changed RPATH");
  writeFileSync(join(destination, "unexpected-tool"), "stale");
  writeFileSync(join(extracted, "usr/lib/libwayland-client.so.0"), "fixture");
  writeFileSync(
    join(extracted, "AppRun.wrapped"),
    "GST_PLUGIN_SYSTEM_PATH_1_0",
  );
  mkdirSync(join(extracted, "usr/bin"));
  writeFileSync(join(extracted, "usr/bin/buzz-foundation"), "fixture app");
  const image = join(root, "fixture.AppImage");
  writeFileSync(
    image,
    '#!/bin/sh\nset -eu\ntest "$1" = --appimage-extract\ncp -a "$FIXTURE_EXTRACTED" squashfs-root\n',
    { mode: 0o755 },
  );
  // Exercise a spaced executable path even when the host Node path has none.
  const node = join(root, "tools/node with spaces");
  symlinkSync(process.execPath, node);
  writeFileSync(
    join(root, "tools/appimagetool"),
    `#!/bin/sh
exec "$FIXTURE_NODE" - "$@" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.argv[2], '--runtime-file');
assert.equal(process.argv[3], process.env.APPIMAGETOOL_RUNTIME_FILE);
fs.cpSync(process.argv[4], process.env.FIXTURE_REPACKED, { recursive: true });
NODE
`,
    { mode: 0o755 },
  );
  const repacked = join(root, "repacked");
  const run = () =>
    spawnSync("bash", [join(root, "scripts/fix-appimage.sh"), image], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${join(root, "tools")}:${dirname(process.execPath)}:${process.env.PATH}`,
        FIXTURE_NODE: node,
        FIXTURE_EXTRACTED: extracted,
        FIXTURE_REPACKED: repacked,
        APPIMAGETOOL_RUNTIME_FILE: join(root, "pinned-runtime"),
      },
    });
  return { source, destination, repacked, resource, run };
}

test("AppImage repair restores original runtime bytes and removes transformed leftovers before repack", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["manifest.json", "buzz-agent"])
    assert.deepEqual(
      readFileSync(join(f.repacked, f.resource, name)),
      readFileSync(join(f.source, name)),
    );
  assert.equal(
    existsSync(join(f.repacked, f.resource, "unexpected-tool")),
    false,
  );
  assert.equal(
    existsSync(join(f.repacked, "usr/lib/libwayland-client.so.0")),
    false,
  );
  assert.equal(
    readFileSync(join(f.repacked, "usr/bin/buzz-foundation.bin"), "utf8"),
    "fixture app",
  );
});

for (const condition of [
  "missing packaged manifest",
  "mismatched manifest",
  "corrupt source",
]) {
  test(`AppImage repair refuses ${condition} before repack`, (t) => {
    const f = fixture(t);
    if (condition === "missing packaged manifest")
      rmSync(join(f.destination, "manifest.json"));
    if (condition === "mismatched manifest")
      writeFileSync(join(f.destination, "manifest.json"), "{}");
    if (condition === "corrupt source")
      writeFileSync(join(f.source, "buzz-agent"), "corrupt");
    assert.notEqual(f.run().status, 0);
    assert.equal(existsSync(f.repacked), false);
  });
}
