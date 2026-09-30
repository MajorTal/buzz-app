import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { expect, test } from "vitest";
import { prepareMedia } from "./media-preparation.mjs";

// Match block/buzz: real conversion tests return early when optional host tools
// are absent. Installed tools must still succeed; conversion failures are not skipped.
function mediaToolVersion(name) {
  try {
    return execFileSync(name, ["-version"], { encoding: "utf8" });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.warn(`skipping real conversion: ${name} not found`);
    return null;
  }
}

test("tiled HEIC preparation preserves the full image dimensions", async () => {
  const version = mediaToolVersion("ffmpeg");
  if (version === null) return;
  // This fixture requires grid support; older host versions remain optional.
  const major = /^ffmpeg version n?(\d+)\./.exec(version)?.[1];
  if (!major || Number(major) < 8) {
    console.warn("skipping tiled HEIC conversion: ffmpeg 8+ required");
    return;
  }
  if (mediaToolVersion("ffprobe") === null) return;
  const bytes = await readFile(
    new URL("../tests/fixtures/media/tiled.heic", import.meta.url),
  );
  const req = Readable.from([bytes]);
  req.headers = { "x-attachment-name": "tiled.heic" };
  await prepareMedia(
    req,
    new AbortController().signal,
    async (path, type, size) => {
      expect(type).toBe("image/jpeg");
      expect(size).toBeGreaterThan(0);
      const dimensions = execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=width,height",
          "-of",
          "csv=p=0",
          path,
        ],
        { encoding: "utf8" },
      );
      expect(dimensions.trim()).toBe("1536,1024");
    },
  );
}, 30_000);
