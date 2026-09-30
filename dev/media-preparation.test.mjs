import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { getPublicKey } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { EventEmitter } from "node:events";
import { open, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, expect, test, vi } from "vitest";

const processFixture = vi.hoisted(() => ({ launch: undefined }));
vi.mock("node:child_process", () => ({
  execFile: (...args) => processFixture.launch(...args),
}));
import { prepareMedia } from "./media-preparation.mjs";
import { VIDEO_PREPARATION_MS } from "../src/features/relay/video-preparation";

const deferred = () => Promise.withResolvers();
function request(name = "clip.mov") {
  const req = Readable.from([Buffer.from("\0\0\0\x14ftypqt  \0\0\0\0qt  ")]);
  req.headers = { "x-attachment-name": encodeURIComponent(name) };
  return req;
}
afterEach(() => vi.restoreAllMocks());

test("one preparation deadline cancels a stalled output pipeline before removing its spool", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  let output;
  processFixture.launch = (_command, args, _options, callback) => {
    const child = new EventEmitter();
    output = args.at(-1);
    void (async () => {
      const file = await open(output, "w");
      await file.truncate(1024 * 1024);
      await file.close();
      callback(null);
      child.emit("close", 0);
    })();
    return child;
  };
  const started = deferred();
  const stopped = deferred();
  let sink;
  const caller = new AbortController();
  const work = prepareMedia(
    request(),
    caller.signal,
    async (path, type, size, signal) => {
      expect(type).toBe("video/mp4");
      expect(size).toBe(1024 * 1024);
      sink = new Writable({
        write(_chunk, _encoding, _callback) {
          started.resolve();
        },
        destroy(error, callback) {
          stopped.resolve();
          callback(error);
        },
      });
      await pipeline(createReadStream(path), sink, { signal });
    },
  );
  const failure = expect(work).rejects.toThrow();
  try {
    await started.promise;
    expect((await stat(output)).size).toBe(1024 * 1024);
    expect(timeout).toHaveBeenCalledWith(VIDEO_PREPARATION_MS);
    deadline.abort(new Error("Preparation deadline"));
    await stopped.promise;
    await failure;
    expect(caller.signal.aborted).toBe(false);
    expect(sink.destroyed).toBe(true);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    deadline.abort();
    await work.catch(() => {});
  }
});

test("disconnect waits for ffmpeg close before deleting input, and never delivers cancelled output", async () => {
  const started = deferred();
  const killed = deferred();
  let close;
  let source;
  processFixture.launch = (_command, args, options, callback) => {
    const child = new EventEmitter();
    source = args[args.indexOf("-i") + 1];
    options.signal.addEventListener(
      "abort",
      () => {
        const error = new Error("Aborted child");
        callback(error);
        child.emit("error", error);
        killed.resolve();
      },
      { once: true },
    );
    close = () => child.emit("close", null);
    started.resolve();
    return child;
  };
  const caller = new AbortController();
  const deliver = vi.fn();
  const work = prepareMedia(request(), caller.signal, deliver);
  const failure = expect(work).rejects.toThrow();
  try {
    await started.promise;
    caller.abort();
    await killed.promise;
    expect((await readFile(source)).length).toBeGreaterThan(0);
    close();
    await failure;
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(deliver).not.toHaveBeenCalled();
  } finally {
    caller.abort();
    close?.();
    await work.catch(() => {});
  }
});

test("the production broker deadline destroys an undrained response, cleans its spool and frees admission", async () => {
  const deadlines = [];
  const originalTimeout = AbortSignal.timeout;
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    if (ms !== VIDEO_PREPARATION_MS) return originalTimeout(ms);
    const deadline = new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  });
  const outputs = [];
  processFixture.launch = (_command, args, _options, callback) => {
    const child = new EventEmitter();
    const output = args.at(-1);
    outputs.push(output);
    void (async () => {
      const file = await open(output, "w");
      await file.truncate(64 * 1024 * 1024); // Sparse, exceeds both socket buffers without allocating payloads.
      await file.close();
      callback(null);
      child.emit("close", 0);
    })();
    return child;
  };
  const key = new Uint8Array(32).fill(7);
  let handler;
  const server = createServer((req, res) => handler(req, res, () => res.end()));
  const plugin = relayBrokerPlugin({
    relayUrl: "https://relay.test",
    identity: () => key.slice(),
    authority: async () => ({ relayAuthor: getPublicKey(key) }),
    upstreamFetch: async (_url, init) => {
      const bytes = Buffer.concat(await Array.fromAsync(init.body));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return Response.json({
        url: `https://relay.test/media/${sha256}.bin`,
        sha256,
        size: bytes.length,
        type: "application/octet-stream",
      });
    },
  });
  await plugin.configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  async function prepare() {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        `${base}/api/relay/prepare-media`,
        { method: "POST", headers: { Origin: base } },
        (res) => {
          res.pause(); // Remains connected; not even the first byte is consumed.
          resolve(res);
        },
      );
      clients.push(req);
      req.on("error", reject);
      req.end(Buffer.from("\0\0\0\x14ftypqt  \0\0\0\0qt  "));
    });
  }
  const upload = () =>
    fetch(`${base}/api/relay/upload`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/octet-stream" },
      body: "notes",
    });
  try {
    const first = await prepare();
    const second = await prepare();
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((await upload()).status).toBe(429);
    expect((await stat(outputs[0])).size).toBe(64 * 1024 * 1024);
    deadlines[0].abort(new Error("Preparation deadline"));
    await vi.waitFor(async () => {
      await expect(stat(outputs[0])).rejects.toMatchObject({ code: "ENOENT" });
    });
    // The deadline, not client close, removed the first spool; second still holds its slot.
    expect(first.destroyed).toBe(false);
    expect((await stat(outputs[1])).size).toBe(64 * 1024 * 1024);
    await vi.waitFor(async () => {
      const response = await upload();
      await response.json();
      expect(response.status).toBe(200);
    });
  } finally {
    for (const deadline of deadlines) deadline.abort();
    for (const client of clients) client.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await vi.waitFor(async () => {
      for (const path of outputs)
        await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }
});

test("old ffmpeg fails closed before HEIC conversion or delivery", async () => {
  const launches = [];
  processFixture.launch = (_command, args, _options, callback) => {
    launches.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => {
      callback(null, "ffmpeg version 7.1.4 Copyright");
      child.emit("close", 0);
    });
    return child;
  };
  const deliver = vi.fn();
  await expect(
    prepareMedia(request("photo.heic"), new AbortController().signal, deliver),
  ).rejects.toMatchObject({ code: "ffmpeg", status: 503 });
  expect(launches).toEqual([["-version"]]);
  expect(deliver).not.toHaveBeenCalled();
});

test("release n-prefix versions permit HEIC conversion", async () => {
  processFixture.launch = (_command, args, _options, callback) => {
    const child = new EventEmitter();
    void (async () => {
      await Promise.resolve(); // execFile cannot close before its listeners exist.
      if (args[0] === "-version")
        callback(null, "ffmpeg version n9.0.2 Copyright");
      else {
        const file = await open(args.at(-1), "w");
        await file.write("jpeg");
        await file.close();
        callback(null);
      }
      child.emit("close", 0);
    })();
    return child;
  };
  const deliver = vi.fn();
  await prepareMedia(
    request("photo.heic"),
    new AbortController().signal,
    deliver,
  );
  expect(deliver).toHaveBeenCalledOnce();
});
