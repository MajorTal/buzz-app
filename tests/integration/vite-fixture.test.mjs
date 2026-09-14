import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "../browser/vite-server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = {
  root,
  configFile: false,
  envDir: false,
  logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
};

test("concurrent fixture servers own distinct optimizer caches and retire only their own files", async () => {
  const servers = [];
  try {
    servers.push(await createServer(config));
    servers.push(await createServer(config));
    const [first, second] = servers;
    assert.notEqual(first.config.cacheDir, second.config.cacheDir);
    assert.notEqual(first.config.cacheDir, join(root, "node_modules/.vite"));
    const retained = join(second.config.cacheDir, "retained-dependency.js");
    await writeFile(retained, "export default 1;");
    await first.close();
    await assert.rejects(stat(first.config.cacheDir), { code: "ENOENT" });
    assert.equal(await readFile(retained, "utf8"), "export default 1;");
    await second.close();
    await assert.rejects(stat(second.config.cacheDir), { code: "ENOENT" });
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("failed fixture creation cleans its owned cache and preserves the error", async () => {
  let cacheDir;
  const failure = new Error("fixture configuration failed");
  await assert.rejects(
    createServer({
      ...config,
      plugins: [
        {
          name: "fail-fixture-configuration",
          configResolved(resolved) {
            cacheDir = resolved.cacheDir;
            throw failure;
          },
        },
      ],
    }),
    (error) => error === failure,
  );
  assert.ok(cacheDir);
  await assert.rejects(stat(cacheDir), { code: "ENOENT" });
});

test("browser fixture call sites cannot fall back to Vite's shared default cache", async () => {
  const browser = join(root, "tests/browser");
  for (const name of await readdir(browser)) {
    if (!name.endsWith(".spec.mjs")) continue;
    const source = await readFile(join(browser, name), "utf8");
    if (!source.includes('import { createServer } from "vite"')) continue;
    // These existing tests own a temporary directory through their full lifecycle.
    assert.equal(name, "conversation.spec.mjs");
    assert.match(
      source,
      /cacheDir[,:]/,
      `${name} must keep its explicit cache`,
    );
  }
});
