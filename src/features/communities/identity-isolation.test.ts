import { Context } from "@deepseek-ai/cordis";
import { assert, afterEach, expect, it, vi } from "vitest";
import { createCommunities, type CommunityIdentitySource } from "./service";
import type { IdentityStatus } from "../identity/contracts";
import type { ReadTransport } from "../relay/transport";
import type { RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import { flush, keypair, signed } from "../relay/testing";
import type { OutgoingEvent } from "../relay/outbox";

const journal = vi.hoisted(() => new Map<string, readonly OutgoingEvent[]>());
vi.mock("../relay/outbox-storage", () => ({
  browserOutboxStorage: (scope: string) => ({
    load: () => structuredClone(journal.get(scope) ?? []),
    save: (records: readonly OutgoingEvent[]) =>
      journal.set(scope, structuredClone(records)),
  }),
}));
const a = keypair(),
  b = keypair(),
  relay = keypair();
const roots: Context[] = [];
const ready = (pubkey = a.pubkey, generation = "2"): IdentityStatus => ({
  state: "ready",
  pubkey,
  generation,
  revocation: "11111111-1111-4111-8111-111111111111",
  busy: false,
  reason: null,
});
function setup(initial: IdentityStatus | null = ready()) {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Broker must not run");
    }),
  );
  let state = initial;
  const listeners = new Set<() => void>();
  const connections: {
    identity: IdentityStatus;
    id: string;
    signal: AbortSignal;
    stream: ReturnType<typeof vi.fn>;
    callbacks: LiveCallbacks | undefined;
    transport: ReadTransport;
  }[] = [];
  const publish = vi.fn((_event: RelayEvent) => new Promise<void>(() => {}));
  const sign = vi.fn(async (event: Parameters<typeof signed>[1]) =>
    signed(a, event),
  );
  const connect: CommunityIdentitySource["connect"] = vi.fn(
    async (identity, id, signal) => {
      const entry = {
        identity,
        id,
        signal,
        stream: vi.fn(),
        callbacks: undefined as LiveCallbacks | undefined,
        transport: undefined as unknown as ReadTransport,
      };
      entry.transport = {
        viewer: identity.pubkey ?? "",
        relayAuthor: relay.pubkey,
        scope: id,
        media: () => undefined,
        query: vi.fn(async () => []),
        writer: { kinds: [9], sign, publish },
        subscribe(callbacks) {
          entry.callbacks = callbacks;
          return { dispose: entry.stream, retry: vi.fn(), update: vi.fn() };
        },
      };
      connections.push(entry);
      return entry.transport;
    },
  );
  const source: CommunityIdentitySource = {
    snapshot: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    connect,
    setup: vi.fn(() => {
      throw new Error("Setup not provided by fixture");
    }),
  };
  const root = new Context();
  roots.push(root);
  const client = createCommunities(root, true, source);
  const change = (next: IdentityStatus | null) => {
    state = next;
    for (const fn of listeners) fn();
  };
  const join = (id = "https://one.example") =>
    client.joined(
      { id, name: id },
      { name: "Local A", picture: "" },
      client.capture(),
    );
  return {
    client,
    source,
    change,
    join,
    connections,
    connect: vi.mocked(connect),
    values,
    root,
    publish,
    sign,
  };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  journal.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("does not contact a broker or community for signed-out or unavailable native identity", () => {
  const { client, change, connect } = setup(null);
  expect(() => client.capture()).toThrow();
  change({ ...ready(), state: "signedOut", pubkey: null });
  expect(client.snapshot()).toMatchObject({
    status: "unavailable",
    memberships: [],
  });
  expect(connect).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it("retires every old session and publishes no old viewer to cancellation or throwing observers", async () => {
  const { client, change, join, connections } = setup();
  join();
  await flush();
  const first = client.relay.snapshot().session;
  const retiredObserver = vi.fn(() => {
    throw new Error("Retired projection observer");
  });
  first.agentActivity.subscribe(retiredObserver);
  join("https://two.example");
  await flush();
  client.relay.snapshot().session.agentActivity.subscribe(retiredObserver);
  const account = client.capture();
  const observed: unknown[] = [];
  account.signal.addEventListener("abort", () =>
    observed.push(client.snapshot().viewer, client.relay.snapshot().viewer),
  );
  client.subscribe(() => {
    throw new Error("Broken observer");
  });
  client.subscribe(() => observed.push(client.snapshot().viewer));
  change(ready(b.pubkey, "5"));
  expect(observed).toEqual([undefined, undefined, b.pubkey]);
  expect(connections).toHaveLength(2);
  expect(connections.every((entry) => entry.signal.aborted)).toBe(true);
  for (const entry of connections)
    expect(entry.stream).toHaveBeenCalledTimes(1);
  expect(first.outbox?.supports(9)).toBe(false);
  expect(retiredObserver).not.toHaveBeenCalled();
  expect(client.snapshot()).toMatchObject({
    viewer: b.pubkey,
    selected: null,
    memberships: [],
    profile: { name: "" },
  });
  expect(() => client.assertCurrent(account)).toThrow();
});
it("same-key new generation retires the owner while equal status leaves it intact", async () => {
  const { client, change, join, connections } = setup();
  join();
  await flush();
  const account = client.capture(),
    session = client.relay.snapshot();
  change({ ...ready() });
  expect(client.capture()).toBe(account);
  expect(client.relay.snapshot()).toBe(session);
  change(ready(a.pubkey, "7"));
  expect(account.signal.aborted).toBe(true);
  expect(client.capture().epoch).toBeGreaterThan(account.epoch);
  await flush();
  expect(connections).toHaveLength(2);
  expect(client.relay.snapshot().session).not.toBe(session.session);
});
it("a different revocation epoch also retires an otherwise identical identity", async () => {
  const { client, change } = setup();
  const account = client.capture();
  change({ ...ready(), revocation: "22222222-2222-4222-8222-222222222222" });
  expect(account.signal.aborted).toBe(true);
  expect(() => client.assertCurrent(account)).toThrow();
});
it("late joins and profile saves cannot adopt B, a same-key replacement, or a forged account", () => {
  const { client, change, values } = setup();
  const account = client.capture();
  change(ready(b.pubkey, "5"));
  const before = client.snapshot();
  expect(() =>
    client.joined(
      { id: "https://late.example", name: "Late" },
      { name: "A", picture: "" },
      account,
    ),
  ).toThrow();
  expect(() =>
    client.saveProfile({ name: "A", picture: "" }, account),
  ).toThrow();
  expect(() =>
    client.saveProfile(
      { name: "forged", picture: "" },
      { ...client.capture() },
    ),
  ).toThrow();
  expect(client.snapshot()).toBe(before);
  expect(values.size).toBe(0);
  change(ready(a.pubkey, "8"));
  expect(() =>
    client.saveProfile({ name: "old A", picture: "" }, account),
  ).toThrow();
});
it("rechecks the account after synchronous join observers before acquiring a session", async () => {
  const { client, change, join, connections, values } = setup();
  const stop = client.subscribe(() => {
    stop();
    change(ready(b.pubkey, "5"));
  });
  expect(() => join()).toThrow();
  await flush();
  expect(connections).toHaveLength(0);
  expect(values.has(`buzz-client.v1:${b.pubkey}`)).toBe(false);
  expect(
    JSON.parse(values.get(`buzz-client.v1:${a.pubkey}`) ?? "null"),
  ).toMatchObject({
    selected: "https://one.example",
  });
});
it("rejects delayed connection results and mismatched viewers without querying them", async () => {
  const { client, change, join, connect } = setup();
  let resolve!: (value: ReadTransport) => void;
  connect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  join();
  await flush();
  change(ready(b.pubkey, "5"));
  const query = vi.fn(async () => []);
  resolve({
    viewer: a.pubkey,
    relayAuthor: relay.pubkey,
    scope: "https://one.example",
    media: () => undefined,
    query,
  });
  await flush();
  expect(query).not.toHaveBeenCalled();
  connect.mockResolvedValueOnce({
    viewer: a.pubkey,
    relayAuthor: relay.pubkey,
    scope: "https://two.example",
    media: () => undefined,
    query,
  });
  join("https://two.example");
  await flush();
  expect(client.relay.snapshot().status).toBe("error");
  expect(query).not.toHaveBeenCalled();
});
it("community switches preserve captured sends; identity retirement preserves exact signed intent only in A/origin", async () => {
  const { client, change, join, publish, sign, connections } = setup();
  join();
  await flush();
  const old = client.relay.snapshot().session.outbox;
  assert.exists(old);
  const id = old.send({
    kind: 9,
    content: "synthetic pending",
    tags: [["h", "c"]],
  });
  await flush();
  await flush();
  expect(publish).toHaveBeenCalledTimes(1);
  const event = structuredClone(publish.mock.calls[0]?.[0]);
  assert.exists(event);
  expect(journal.get(`https://one.example:${a.pubkey}`)?.[0]?.signed).toEqual(
    event,
  );
  join("https://two.example");
  await flush();
  expect(connections[0]?.signal.aborted).toBe(false);
  expect(old.supports(9)).toBe(true);
  change(ready(b.pubkey, "5"));
  await flush();
  expect(old.supports(9)).toBe(false);
  join();
  await flush();
  expect(client.relay.snapshot().session.outbox?.snapshot()).toEqual([]);
  change(ready(a.pubkey, "8"));
  await flush();
  client.select("https://one.example");
  await flush();
  const restored = client.relay.snapshot().session.outbox?.snapshot();
  assert.exists(restored);
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({
    event: { id },
    signed: event,
    delivery: "unknown",
  });
  expect(sign).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});
it("cancellation-time identity changes cannot activate the pre-cleanup snapshot", async () => {
  const { client, change, join } = setup();
  join();
  await flush();
  client.capture().signal.addEventListener("abort", () => change(null));
  change(ready(b.pubkey, "5"));
  expect(client.snapshot()).toMatchObject({
    status: "unavailable",
    selected: null,
  });
  expect(() => client.capture()).toThrow();
});

it("rejects a native connector that returns the wrong durable origin partition", async () => {
  const { client, join, connect } = setup();
  const query = vi.fn(async () => []);
  connect.mockResolvedValueOnce({
    viewer: a.pubkey,
    relayAuthor: relay.pubkey,
    scope: "https://other.example",
    media: () => undefined,
    query,
  });
  join();
  await flush();
  expect(client.relay.snapshot().status).toBe("error");
  expect(query).not.toHaveBeenCalled();
});
it("clears unresolved aliases and hydrates only the next viewer's saved selection", async () => {
  const { client, change, values, connections } = setup(null);
  values.set(
    `buzz-client.v1:${a.pubkey}`,
    JSON.stringify({
      profile: { name: "A", picture: "" },
      memberships: [{ id: "unconfigured-old", name: "A alias" }],
      selected: "unconfigured-old",
    }),
  );
  values.set(
    `buzz-client.v1:${b.pubkey}`,
    JSON.stringify({
      profile: { name: "B", picture: "" },
      memberships: [{ id: "https://b.example", name: "B" }],
      selected: "https://b.example",
    }),
  );
  change(ready());
  expect(connections).toHaveLength(0);
  change(ready(b.pubkey, "5"));
  await flush();
  expect(connections.map((entry) => entry.id)).toEqual(["https://b.example"]);
  client.saveProfile({ name: "B updated", picture: "" }, client.capture());
  expect(
    JSON.parse(values.get(`buzz-client.v1:${b.pubkey}`) ?? "null").memberships,
  ).toEqual([{ id: "https://b.example", name: "B" }]);
});

it("retirement before a scheduled connect prevents the connector from running at all", async () => {
  const { change, join, connect } = setup();
  join();
  change(null);
  await flush();
  expect(connect).not.toHaveBeenCalled();
});
it("a ready account cannot write through missing capture arguments or after owner disposal", async () => {
  const { client, root } = setup();
  expect(() =>
    Reflect.apply(client.saveProfile, client, [
      { name: "No capture", picture: "" },
    ]),
  ).toThrow();
  const account = client.capture();
  await root.fiber.dispose();
  expect(() =>
    client.saveProfile({ name: "Disposed", picture: "" }, account),
  ).toThrow();
});

it("captures canonical setup origin and native authority without contacting the broker", async () => {
  const { client, source, change } = setup();
  const host = {
    info: vi.fn(async () => ({ policy: null })),
    inspectProfile: vi.fn(async () => ({
      exists: false,
      profile: { name: "", picture: "" },
      existing: {},
    })),
    acceptPolicy: vi.fn(async () => ({ receipt: "r" })),
    claim: vi.fn(async () => ({ status: "joined" })),
    publishProfile: vi.fn(async () => {}),
  };
  const create = vi.mocked(source.setup).mockReturnValue(host);
  const account = client.capture();
  const bound = client.setup("wss://ONE.example:443/", account);
  expect(create).toHaveBeenCalledExactlyOnceWith(
    ready(),
    "https://one.example",
    account,
    expect.any(Function),
  );
  await expect(bound.info()).resolves.toEqual({ policy: null });
  await expect(bound.inspectProfile()).resolves.toMatchObject({
    exists: false,
  });
  const policy = { code: "invite", policy_version: "v1", age_confirmed: false };
  const claim = { code: "invite", policy_receipt: "r" };
  await bound.acceptPolicy(policy);
  await bound.claim(claim);
  await bound.publishProfile(
    { name: "A", picture: "" },
    { about: "preserved" },
  );
  expect(host.acceptPolicy).toHaveBeenCalledExactlyOnceWith(policy);
  expect(host.claim).toHaveBeenCalledExactlyOnceWith(claim);
  expect(host.publishProfile).toHaveBeenCalledExactlyOnceWith(
    { name: "A", picture: "" },
    { about: "preserved" },
  );
  change(ready(b.pubkey, "4"));
  for (const action of [
    () => bound.info(),
    () => bound.inspectProfile(),
    () => bound.acceptPolicy(policy),
    () => bound.claim(claim),
    () => bound.publishProfile({ name: "stale", picture: "" }, {}),
  ]) {
    await expect(action()).rejects.toThrow("Account changed");
  }
  for (const fn of Object.values(host)) expect(fn).toHaveBeenCalledTimes(1);
  expect(() => client.setup("https://one.example", account)).toThrow(
    "Account changed",
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  "info",
  "inspectProfile",
  "acceptPolicy",
  "claim",
  "publishProfile",
] as const)(
  "rejects late native %s results after a same-key generation change without retry",
  async (name) => {
    const { client, source, change } = setup();
    let release!: (value: unknown) => void;
    const work = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const host = {
      info: work,
      inspectProfile: work,
      acceptPolicy: work,
      claim: work,
      publishProfile: work,
    };
    vi.mocked(source.setup).mockReturnValue(
      host as unknown as ReturnType<CommunityIdentitySource["setup"]>,
    );
    const bound = client.setup("https://one.example", client.capture());
    const pending =
      name === "info"
        ? bound.info()
        : name === "inspectProfile"
          ? bound.inspectProfile()
          : name === "acceptPolicy"
            ? bound.acceptPolicy({
                code: "i",
                policy_version: "v",
                age_confirmed: false,
              })
            : name === "claim"
              ? bound.claim({ code: "i" })
              : bound.publishProfile({ name: "A", picture: "" }, {});
    change(ready(a.pubkey, "4"));
    release({ policy: null, receipt: "r", status: "joined" });
    await expect(pending).rejects.toThrow("Account changed");
    expect(work).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);
