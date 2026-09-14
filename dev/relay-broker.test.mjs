import { test } from "vitest";
import assert from "node:assert/strict";
import {
  createUpstream,
  validFilters,
  validMessageTemplate,
} from "./relay-broker.mjs";

test("read broker accepts non-channel finite reads without relaxing filter budgets", () => {
  for (const filter of [
    { kinds: [13534], limit: 1 },
    { kinds: [30078], authors: ["viewer"], "#d": ["channel-stars"], limit: 1 },
    { kinds: [1621], "#a": ["30617:owner:repo"], limit: 200 },
    { ids: ["event"], limit: 1 },
    { kinds: [9], search: "design", limit: 20 },
    { kinds: [9], "#e": ["root"], depth_limit: 10, limit: 80 },
  ])
    assert.equal(validFilters([filter]), true);
  for (const filters of [
    [],
    Array(5).fill({ kinds: [0], limit: 1 }),
    [{ kinds: [0], limit: 501 }],
    [{ kinds: [0], limit: 0 }],
    [{ kinds: [-1], limit: 1 }],
    [{ kinds: [65536], limit: 1 }],
    [{ kinds: [], limit: 1 }],
    [{ limit: 1 }],
  ])
    assert.equal(validFilters(filters), false);
});

test("broker signing is limited to bounded channel messages and canonical direct replies", () => {
  const message = {
    kind: 9,
    content: "hello",
    created_at: 1788810000,
    tags: [
      ["h", "channel"],
      ["client-id", "unique"],
    ],
  };
  assert.equal(validMessageTemplate(message), true);
  const reply = ["e", "a".repeat(64), "", "reply"];
  assert.equal(
    validMessageTemplate({ ...message, tags: [...message.tags, reply] }),
    true,
  );
  for (const references of [
    [["e", "a".repeat(64)]],
    [["e", "a".repeat(64), "", "root"]],
    [["e", "invalid", "", "reply"]],
    [["e", "a".repeat(64), "untrusted relay", "reply"]],
    [[...reply, "extra"]],
    [reply, reply],
  ])
    assert.equal(
      validMessageTemplate({
        ...message,
        tags: [...message.tags, ...references],
      }),
      false,
    );
  for (const invalid of [
    { ...message, kind: 9005 },
    { ...message, content: " " },
    { ...message, content: "x".repeat(33000) },
    { ...message, tags: [] },
    {
      ...message,
      tags: [
        ["h", "channel"],
        ["e", "thread"],
      ],
    },
    {
      ...message,
      tags: [
        ["h", "channel"],
        ["h", "other"],
      ],
    },
  ])
    assert.equal(validMessageTemplate(invalid), false);
});

test("membership signing permits only a single bot addition", () => {
  const event = {
    kind: 9000,
    content: "",
    created_at: 1788810000,
    tags: [
      ["h", "dde67da5-fb84-47ce-8feb-64c9ad7b1d52"],
      ["p", "a".repeat(64)],
      ["role", "bot"],
    ],
  };
  assert.equal(validMessageTemplate(event), true);
  assert.equal(
    validMessageTemplate({
      ...event,
      tags: [
        ...event.tags,
        ["client-id", "dde67da5-fb84-47ce-8feb-64c9ad7b1d52"],
      ],
    }),
    true,
  );
  for (const invalid of [
    { ...event, content: "extra" },
    { ...event, tags: [...event.tags, ["p", "b".repeat(64)]] },
    { ...event, tags: [...event.tags.slice(0, 2), ["role", "admin"]] },
    { ...event, tags: [...event.tags.slice(0, 2), ["role", "owner"]] },
  ])
    assert.equal(validMessageTemplate(invalid), false);
});

test("the upstream pool reuses warm connections and reports only new connects", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => res.end("{}"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upstream = createUpstream(base);
  const request = () =>
    upstream
      .fetch(`${base}/query`, { method: "POST", body: "[]" })
      .then((response) => response.text());
  try {
    const before = upstream.connects();
    await upstream.warm();
    assert.equal(upstream.connects(), before + 1);
    assert.match(upstream.connectTiming(before)[0], /^connect;dur=[\d.]+$/);
    // The pool may open a second socket while the first is being released.
    await request();
    await request();
    const warmed = upstream.connects();
    assert.ok(warmed <= before + 2);
    await request();
    assert.equal(upstream.connects(), warmed);
    assert.deepEqual(upstream.connectTiming(warmed), []);
  } finally {
    await upstream.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
