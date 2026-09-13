import { test, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { createHash } from "node:crypto";
import { policyRelay } from "../tests/browser/policy-relay.mjs";

// Positive controls for the modeled upstream used by the browser measurements.
// No actual app or deployed relay is involved in these enforcement checks.
test("modeled presence quota enforcement rejects overload across sockets and HTTP purposes", async () => {
  const key = generateSecretKey(),
    viewer = getPublicKey(key);
  const report = { queries: [], unexpected: [] };
  let clock = 1000;
  const sign = (kind, tags = [], content = "online") =>
    finalizeEvent(
      { kind, tags, content, created_at: Math.floor(clock / 1000) },
      key,
    );
  const relay = policyRelay({
    viewer,
    report,
    pending: [],
    answer: () => [],
    presenceSnapshot: () => {},
    acceptPublication: () => {},
    enforceQuotas: true,
    now: () => clock,
  });
  async function post(body, path = "/query", community = "primary") {
    const url = `https://${community}.example${path}`;
    const payload = JSON.stringify(body);
    const auth = sign(27235, [
      ["u", url],
      ["payload", createHash("sha256").update(payload).digest("hex")],
    ]);
    return relay.fetch(url, {
      body: payload,
      headers: {
        Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
      },
      signal: new AbortController().signal,
    });
  }
  for (let i = 0; i < 300; i++) {
    const filters =
      i % 2
        ? [{ kinds: [20001], authors: [viewer], limit: 1 }]
        : [{ kinds: [9], "#h": ["alpha"], limit: 1 }];
    expect((await post(filters)).status).toBe(200);
  }
  const denied = await post(sign(9, [["h", "alpha"]], "over quota"), "/events");
  expect(denied.status).toBe(429);
  expect((await denied.json()).error).toContain("rate-limited:");
  expect(report.quotaRefusals.at(-1).category).toBe("ApiCalls");
  expect(
    (await post([{ kinds: [9], limit: 1 }], "/query", "secondary")).status,
  ).toBe(200);
  clock += 60000;
  expect((await post([{ kinds: [9], limit: 1 }])).status).toBe(200);

  const sockets = Array.from({ length: 8 }, () =>
    relay.socket("wss://primary.example"),
  );
  for (const socket of sockets)
    socket.send(
      JSON.stringify(["AUTH", sign(22242, [["challenge", "policy-fixture"]])]),
    );
  const frames = [];
  for (const socket of sockets)
    socket.onmessage = ({ data }) => frames.push(JSON.parse(data));
  for (let i = 0; i < 51; i++)
    sockets[i % 8].send(
      JSON.stringify([
        "REQ",
        `request-${i}`,
        i % 2
          ? { kinds: [20001], authors: [viewer], limit: 0 }
          : { kinds: [9], "#h": ["alpha"], limit: 1 },
      ]),
    );
  await Promise.resolve();
  expect(relay.requests).toHaveLength(50);
  expect(frames).toContainEqual([
    "CLOSED",
    "request-50",
    expect.stringContaining("rate-limited:"),
  ]);
  expect(report.quotaRefusals.at(-1).category).toBe("WsEvents");
  // Separate message quota: stay below each 50/5s WS burst but send 61 EVENTs/min.
  clock += 5000;
  for (let i = 0; i < 61; i++) {
    if (i === 30) clock += 5000;
    sockets[i % 8].send(JSON.stringify(["EVENT", sign(20001)]));
  }
  await Promise.resolve();
  expect(report.presencePublications).toHaveLength(60);
  expect(report.quotaRefusals.at(-1).category).toBe("Messages");
  expect(frames).toContainEqual([
    "OK",
    expect.any(String),
    false,
    expect.stringContaining("rate-limited:"),
  ]);
  expect(report.quotaRefusals.map(({ category }) => category)).toEqual([
    "ApiCalls",
    "WsEvents",
    "Messages",
  ]);
  expect(report.unexpected).toEqual([]);
  for (const socket of sockets) socket.close();
});
