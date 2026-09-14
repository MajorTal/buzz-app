import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { WORKFLOW_READ_BYTES } from "../src/features/workflows/http.ts";

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, finalizeEvent: vi.fn(actual.finalizeEvent) };
});

const id = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const cursor = { before: "2026-09-12T14:44:19.123456+00:00", beforeId: runId };
async function harness(
  respond = () => Response.json({ runs: [], next: null }),
  metadata,
) {
  const key = new Uint8Array(32);
  key[31] = 8;
  const viewer = getPublicKey(key),
    calls = [],
    logs = [];
  let handler;
  const server = createServer((req, res) => {
    if (!req.headers.origin) req.headers.origin = `http://${req.headers.host}`;
    void handler(req, res);
  });
  await relayBrokerPlugin({
    relayUrl: "https://a.workflow.test",
    communityAliases: JSON.stringify({ secondary: "https://b.workflow.test" }),
    identity: () => key,
    ...(metadata ? {} : { authority: async () => ({ relayAuthor: viewer }) }),
    upstreamFetch: async (url, init) => {
      if (init.headers.Accept === "application/nostr+json") {
        expect(init.redirect).toBe("error");
        const data = await metadata(String(url), viewer, init);
        if (data instanceof Error) throw data;
        return data instanceof Response ? data : Response.json(data);
      }
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(viewer);
      const call = { url: String(url), init, auth };
      calls.push(call);
      return respond(call);
    },
  }).configureServer({
    httpServer: server,
    config: {
      logger: {
        info() {},
        error(text) {
          logs.push(text);
        },
      },
    },
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    viewer,
    calls,
    logs,
    post: (route, body, headers = {}) =>
      fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const signal = () => new AbortController().signal;
it("real broker scoped history signs exact GET path/cursor and captured principal without startup reads or workflow writes", async () => {
  const h = await harness();
  try {
    const first = await connectBrokerTransport(h.base);
    const other = await connectBrokerTransport(h.base, undefined, "secondary");
    expect(h.calls).toHaveLength(0);
    expect(first.writer.kinds).toEqual([7, 9, 30620, 46020, 5]);
    await first.workflows.runs(id, cursor, signal());
    await other.workflows.runs(id, undefined, signal());
    await first.workflows.runs(id, undefined, signal());
    expect(h.calls.map((call) => call.url)).toEqual([
      `https://a.workflow.test/workflows/${id}/runs?limit=20&before=2026-09-12T14%3A44%3A19.123456%2B00%3A00&before_id=${runId}`,
      `https://b.workflow.test/workflows/${id}/runs?limit=20`,
      `https://a.workflow.test/workflows/${id}/runs?limit=20`,
    ]);
    for (const { url, init, auth } of h.calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe("error");
      expect(auth.tags).toContainEqual(["u", url]);
      expect(auth.tags).toContainEqual(["method", "GET"]);
      expect(auth.tags.some(([name]) => name === "payload")).toBe(false);
      expect(auth.tags.some(([name]) => name === "nonce")).toBe(true);
    }
    expect(new Set(h.calls.map(({ auth }) => auth.id)).size).toBe(3);
  } finally {
    await h.close();
  }
});
it("broker rejects arbitrary targets, cursors, limits and untrusted origin before upstream dispatch", async () => {
  const h = await harness();
  try {
    for (const body of [
      null,
      { id: "../secret" },
      { id, limit: 100 },
      { id, url: "https://evil.test" },
      { id, cursor: { before: cursor.before } },
      { id, cursor: { ...cursor, before: "not a date" } },
      { id, cursor: { ...cursor, beforeId: "../" } },
      { id, cursor: null },
    ]) {
      expect((await h.post("workflow-runs", body)).status).toBe(400);
    }
    expect(
      (await h.post("workflow-approvals", { id, runId: "../" })).status,
    ).toBe(404);
    expect(
      (await h.post("workflow-runs", { id }, { Origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});
it("workflow quota gates the existing query lane while another community remains independent", async () => {
  const h = await harness(({ url }) =>
    url.startsWith("https://a.")
      ? Response.json(
          { error: "rate-limited: quota exceeded; retry in 0s" },
          { status: 429 },
        )
      : Response.json([]),
  );
  try {
    const transport = await connectBrokerTransport(h.base);
    await expect(
      transport.workflows.runs(id, undefined, signal()),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 1000 });
    await expect(
      transport.query([{ kinds: [0], limit: 1 }]),
    ).rejects.toMatchObject({ status: 429 });
    expect(h.calls).toHaveLength(1);
    const other = await connectBrokerTransport(h.base, undefined, "secondary");
    await other.query([{ kinds: [0], limit: 1 }]);
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});
it("workflow 404 remains unavailable, over-budget body is cancelled without leaking bytes", async () => {
  let large = false,
    cancelled = false;
  const h = await harness(() =>
    large
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  "PRIVATE".repeat(Math.ceil(WORKFLOW_READ_BYTES / 7) + 1),
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
        )
      : Response.json({ error: "PRIVATE missing workflow" }, { status: 404 }),
  );
  try {
    const transport = await connectBrokerTransport(h.base);
    await expect(
      transport.workflows.runs(id, undefined, signal()),
    ).rejects.toMatchObject({ status: 404 });
    large = true;
    await expect(
      transport.workflows.runs(id, undefined, signal()),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(h.logs.join(" ")).not.toContain("PRIVATE");
  } finally {
    await h.close();
  }
});
it("closing workflow interest aborts the actual broker upstream request", async () => {
  const h = await harness(
    ({ init }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        );
      }),
  );
  try {
    const transport = await connectBrokerTransport(h.base),
      cancel = new AbortController();
    const pending = transport.workflows.runs(id, undefined, cancel.signal);
    const rejection = expect(pending).rejects.toThrow();
    for (let i = 0; i < 100 && !h.calls.length; i++) await delay(5);
    expect(h.calls).toHaveLength(1);
    cancel.abort();
    await rejection;
    for (let i = 0; i < 100 && !h.calls[0].init.signal.aborted; i++)
      await delay(5);
    expect(h.calls[0].init.signal.aborted).toBe(true);
  } finally {
    await h.close();
  }
});

const existingBackend = (_url, viewer) => ({ self: viewer });
const yaml =
  "name: Local test\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: wait\n    action: delay\n    duration: 1s\n";
const template = (kind = 30620) => ({
  kind,
  created_at: Math.floor(Date.now() / 1000),
  content: kind === 30620 ? yaml : "",
  tags: [
    ["h", runId],
    ["d", id],
  ],
});
it("existing backend signs only canonical workflow sign/publish with exact own events and unchanged receipts", async () => {
  const h = await harness(({ init }) => {
    const event = JSON.parse(init.body);
    expect(verifyEvent(event)).toBe(true);
    return Response.json({
      accepted: true,
      event_id: event.id,
      message: "workflow-result",
    });
  }, existingBackend);
  try {
    const t = await connectBrokerTransport(h.base);
    expect(t.writer.kinds).toEqual([7, 9, 30620, 46020, 5]);
    for (const input of [
      template(),
      template(46020),
      {
        ...template(5),
        tags: [
          ["h", runId],
          ["a", `30620:${h.viewer}:${id}`],
        ],
      },
    ]) {
      const event = await t.writer.sign(input, signal());
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(h.viewer);
      expect(event.kind).toBe(input.kind);
      expect(event.content).toBe(input.content);
      expect(event.tags).toEqual(input.tags);
      expect(await t.writer.publish(event, signal())).toBe("workflow-result");
      expect(JSON.parse(h.calls.at(-1).init.body)).toEqual(
        JSON.parse(JSON.stringify(event)),
      );
    }
    expect(h.calls).toHaveLength(3);
  } finally {
    await h.close();
  }
});
const invalidCommands = [
  ["null", () => null],
  ["admin deletion", () => ({ ...template(), kind: 9005 })],
  [
    "legacy name",
    () => ({
      ...template(),
      tags: [
        ["h", runId],
        ["d", "name"],
      ],
    }),
  ],
  [
    "webhook",
    () => ({
      ...template(),
      content: yaml.replace("message_posted", "webhook"),
    }),
  ],
  [
    "event-target deletion",
    () => ({
      ...template(5),
      tags: [
        ["h", runId],
        ["e", "a".repeat(64)],
      ],
    }),
  ],
  [
    "numeric alias",
    (viewer) => ({
      ...template(5),
      tags: [
        ["h", runId],
        ["a", `030620:${viewer}:${id}`],
      ],
    }),
  ],
  [
    "other owner",
    () => ({
      ...template(5),
      tags: [
        ["h", runId],
        ["a", `30620:${"a".repeat(64)}:${id}`],
      ],
    }),
  ],
  [
    "extra tag",
    () => ({
      ...template(),
      tags: [...template().tags, ["p", "a".repeat(64)]],
    }),
  ],
];
it.each(invalidCommands)(
  "existing-backend broker rejects %s before signing or upstream writes",
  async (_name, input) => {
    const h = await harness(() => {
      throw new Error("must not dispatch writes");
    }, existingBackend);
    try {
      const signaturesBefore = finalizeEvent.mock.calls.length;
      expect((await h.post("sign", input(h.viewer))).status).toBe(400);
      expect(finalizeEvent.mock.calls).toHaveLength(signaturesBefore);
      expect(h.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  },
);
it("existing-backend broker rejects forged commands before upstream writes", async () => {
  const h = await harness(() => {
    throw new Error("must not dispatch writes");
  }, existingBackend);
  try {
    const own = await (await h.post("sign", template())).json();
    expect(
      (await h.post("publish", { ...own, content: "tampered" })).status,
    ).toBe(400);
    expect(
      (await h.post("publish", { ...own, pubkey: "a".repeat(64) })).status,
    ).toBe(400);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});
