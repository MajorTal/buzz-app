import { fixtureRelayUrl } from "../tests/relay-config.ts";
import { expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installedBuzzDataDir,
  projectAgentLibrary,
  readAgentLibrary,
} from "./agent-library.mjs";

it("locates the installed Buzz data directory per platform and refuses to guess elsewhere", () => {
  expect(installedBuzzDataDir("darwin", {}, "/Users/t")).toBe(
    "/Users/t/Library/Application Support/xyz.block.buzz.app",
  );
  expect(installedBuzzDataDir("linux", {}, "/home/t")).toBe(
    "/home/t/.local/share/xyz.block.buzz.app",
  );
  expect(
    installedBuzzDataDir("linux", { XDG_DATA_HOME: "/data" }, "/home/t"),
  ).toBe("/data/xyz.block.buzz.app");
  // Tauri's dirs crate ignores a relative XDG_DATA_HOME; so must this reader,
  // or it would look where the installed app never writes.
  for (const XDG_DATA_HOME of ["relative", "./data", ""])
    expect(
      installedBuzzDataDir("linux", { XDG_DATA_HOME }, "/home/t"),
      JSON.stringify(XDG_DATA_HOME),
    ).toBe("/home/t/.local/share/xyz.block.buzz.app");
  expect(installedBuzzDataDir("win32", {}, "/home/t")).toBeUndefined();
  expect(installedBuzzDataDir("freebsd", {}, "/home/t")).toBeUndefined();
});
const key = "a".repeat(64);
const rows = [
  {
    pubkey: "",
    name: "legacy",
    display_name: "Brain",
    slug: "brain",
    private_key_nsec: "secret",
    system_prompt: "private instructions",
    env_vars: { TOKEN: "private token" },
  },
  {
    pubkey: key,
    name: "Brain",
    persona_id: "brain",
    private_key_nsec: "secret",
    auth_tag: "private auth",
  },
  { pubkey: "", name: "Hidden", slug: "hidden", is_active: false },
  { pubkey: "", name: "No coordinate" },
];
it("projects selected definitions and exact linked keys, never arbitrary config/secrets", () => {
  expect(projectAgentLibrary(rows)).toEqual({
    definitions: [{ id: "brain", name: "Brain" }],
    identities: [{ pubkey: key, name: "Brain", definitionId: "brain" }],
  });
});
it("projects only safe optional avatar artwork without broadening the public fields", () => {
  const avatar = "https://images.example/brain.png";
  const data = "data:image/png;base64,aGVsbG8=";
  expect(
    projectAgentLibrary([
      { ...rows[0], avatar_url: data },
      { ...rows[1], avatar_url: avatar },
    ]),
  ).toEqual({
    definitions: [{ id: "brain", name: "Brain", avatar: data }],
    identities: [{ pubkey: key, name: "Brain", definitionId: "brain", avatar }],
  });
  for (const avatar_url of [
    "file:///secret",
    "javascript:alert(1)",
    "https://user:secret@example.com/picture",
    "data:image/svg+xml;base64,PHN2Zz4=",
    `data:image/png;base64,${"A".repeat(512 * 1024)}`,
    {},
    null,
  ]) {
    expect(
      projectAgentLibrary([{ ...rows[0], avatar_url }]).definitions,
    ).toEqual([{ id: "brain", name: "Brain" }]);
  }
});
it("read is byte-preserving and rejects missing/malformed/nonregular/oversized sources without copying data into errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzz-library-"));
  const path = join(root, "managed-agents.json");
  try {
    const raw = JSON.stringify(rows);
    await writeFile(path, raw);
    expect(await readAgentLibrary(path)).toEqual(projectAgentLibrary(rows));
    expect(await readFile(path, "utf8")).toBe(raw);
    await symlink(path, join(root, "link"));
    for (const bad of [join(root, "link"), join(root, "missing"), root])
      await expect(readAgentLibrary(bad)).rejects.toThrow("Could not read");
    await writeFile(path, "private broken content");
    await expect(readAgentLibrary(path)).rejects.toThrow("Could not read");
    expect(await readFile(path, "utf8")).toBe("private broken content");
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(readAgentLibrary(path)).rejects.toThrow("Could not read");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([
  null,
  {},
  Array(2001).fill(rows[0]),
  [{ pubkey: "bad", name: "private" }],
  [rows[1], rows[1]],
  [rows[0], rows[0]],
  [{ ...rows[0], is_active: "false" }],
])(
  "malformed display fields fail instead of inventing an empty library (%#)",
  (raw) => {
    expect(() => projectAgentLibrary(raw)).toThrow("Could not read");
  },
);

it("actual broker and transport expose only the library projection, reject cross-origin reads, and retry failures", async () => {
  const { createServer } = await import("node:http");
  const { generateSecretKey, getPublicKey } = await import("nostr-tools");
  const { relayBrokerPlugin } = await import("./relay-broker.mjs");
  const { connectBrokerTransport } = await import(
    "../src/features/relay/transport.ts"
  );
  const root = await mkdtemp(join(tmpdir(), "buzz-library-http-"));
  const path = join(root, "managed-agents.json");
  await writeFile(path, JSON.stringify(rows));
  let handler,
    reads = 0;
  const server = createServer((req, res) =>
    handler(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  await relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    identity: generateSecretKey,
    authority: async () => ({ relayAuthor: getPublicKey(generateSecretKey()) }),
    agentLibrary: () => {
      reads++;
      return readAgentLibrary(path);
    },
  }).configureServer({
    httpServer: server,
    config: { logger: { info() {} } },
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const transport = await connectBrokerTransport(base);
    expect(reads).toBe(0);
    expect(
      await transport.readAgentLibrary(new AbortController().signal),
    ).toEqual(projectAgentLibrary(rows));
    const bad = await fetch(`${base}/api/relay/agent-library`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(bad.status).toBe(403);
    expect(reads).toBe(1);
    await writeFile(path, "secret malformed value");
    await expect(
      transport.readAgentLibrary(new AbortController().signal),
    ).rejects.toThrow();
    const error = await fetch(`${base}/api/relay/agent-library`);
    expect(await error.text()).not.toContain("secret");
    await writeFile(path, JSON.stringify(rows));
    expect(
      await transport.readAgentLibrary(new AbortController().signal),
    ).toEqual(projectAgentLibrary(rows));
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(rows));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
