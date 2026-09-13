import { createServer as createViteServer } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Parallel fixture servers must not invalidate each other's optimized imports.
export async function createServer(config) {
  const cacheDir = await mkdtemp(join(tmpdir(), "buzz-fixture-vite-"));
  try {
    const server = await createViteServer({ ...config, cacheDir });
    const close = server.close.bind(server);
    server.close = async () => {
      try {
        await close();
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    };
    return server;
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
