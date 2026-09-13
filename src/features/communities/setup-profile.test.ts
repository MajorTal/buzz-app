import { assert, afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  createCommunities,
  type CommunityAccount,
  type CommunityIdentitySource,
} from "./service";
import { createSetupProfile } from "./setup-profile";
import { waitForSetupSession } from "./setup-session";
import type { RelayData } from "../relay/service";
import { createRelaySession } from "../relay/session";
import { keypair, profile, signed, flush } from "../relay/testing";
import { newer, type ReadFilter, type RelayEvent } from "../relay/events";
import type { OutgoingEvent, OutboxStorage } from "../relay/outbox";
import type { EventTemplate } from "nostr-tools";
import type { ReadTransport } from "../relay/transport";
import type { IdentityStatus } from "../identity/contracts";

vi.mock("../relay/outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));
const key = keypair(),
  relay = keypair();
const roots: Context[] = [],
  disposals: (() => void)[] = [];
function fixture(storage?: OutboxStorage) {
  const controller = new AbortController();
  const account: CommunityAccount = {
    viewer: key.pubkey,
    epoch: 1,
    signal: controller.signal,
  };
  let current: RelayEvent | undefined;
  const sign = vi.fn(async (template: EventTemplate) => signed(key, template));
  const publish = vi.fn(async (event: RelayEvent) => {
    current = newer(current, event);
  });
  const query: ReadTransport["query"] = vi.fn(
    async (filters: readonly ReadFilter[]) =>
      filters.some(
        (f) => f.kinds?.includes(0) || f.ids?.includes(current?.id ?? ""),
      ) && current
        ? [current]
        : [],
  );
  const transport: ReadTransport = {
    viewer: key.pubkey,
    relayAuthor: relay.pubkey,
    scope: "https://one.example",
    media: () => undefined,
    query,
    writer: { kinds: [0, 9], sign, publish },
  };
  const store = createRelaySession(transport, {
    outboxStorage: storage ?? { load: () => [], save: () => {} },
  });
  disposals.push(store.dispose);
  const owner: RelayData = {
    snapshot: () => ({
      status: "ready",
      generation: 1,
      session: store.session,
    }),
    subscribe: () => () => {},
    retry: vi.fn(),
    disconnect: vi.fn(),
    clearCache: store.clearCache,
  };
  const acquire = () => waitForSetupSession(owner, account.signal);
  const setup = createSetupProfile(acquire, account);
  return {
    setup,
    store,
    controller,
    sign,
    publish,
    transport,
    acquire,
    setCurrent: (event?: RelayEvent) => {
      current = event;
    },
  };
}
afterEach(async () => {
  for (const dispose of disposals.splice(0)) dispose();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("waits for hydration before deciding whether to create profile intent", async () => {
  let release!: (records: readonly OutgoingEvent[]) => void;
  const load = new Promise<readonly OutgoingEvent[]>((resolve) => {
    release = resolve;
  });
  const saved = signed(key, {
    kind: 0,
    content: JSON.stringify({
      name: "Saved",
      display_name: "Saved",
      picture: "",
      about: "keep",
    }),
    tags: [["client-id", "saved"]],
  });
  const f = fixture({ load: () => load, save: () => {} });
  const result = f.setup.publishProfile(
    { name: "Saved", picture: "" },
    { about: "keep" },
  );
  await flush();
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  release([{ event: saved, signed: saved, delivery: "unknown" }]);
  await result;
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(
    saved,
    expect.any(AbortSignal),
  );
});
it("shares one intent across concurrent submissions and preserves unexposed fields", async () => {
  const f = fixture();
  await Promise.all([
    f.setup.publishProfile({ name: "New", picture: "" }, { about: "keep" }),
    f.setup.publishProfile({ name: "New", picture: "" }, { about: "keep" }),
  ]);
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(f.publish).toHaveBeenCalledTimes(1);
  const event = f.publish.mock.calls[0]?.[0];
  assert.exists(event);
  expect(JSON.parse(event.content)).toEqual({
    name: "New",
    display_name: "New",
    picture: "",
    about: "keep",
  });
  await f.setup.publishProfile({ name: "New", picture: "" }, {});
  expect(f.publish).toHaveBeenCalledTimes(1);
});
it("own-profile evidence excludes locally signed pending intent", async () => {
  const f = fixture();
  f.publish.mockImplementation(async () => new Promise(() => {}));
  const session = await f.acquire();
  session.outbox?.send({
    kind: 0,
    content: '{"name":"Local","picture":""}',
    tags: [],
  });
  await flush();
  expect(await session.ownProfile()).toBeUndefined();
  const projected = await session.read([
    { kinds: [0], authors: [key.pubkey], limit: 5 },
  ]);
  expect(projected).toHaveLength(1);
  expect(await f.setup.inspectProfile()).toMatchObject({
    exists: false,
    pending: true,
    profile: { name: "Local" },
  });
});
it("accepted superseded profiles are not reported as current and never sign a newer replacement", async () => {
  const saved = profile(key, { name: "Old", picture: "" }, 100);
  const current = profile(key, { name: "New", picture: "" }, 200);
  const f = fixture({
    load: () => [{ event: saved, signed: saved, delivery: "unknown" }],
    save: () => {},
  });
  f.setCurrent(current);
  await expect(
    f.setup.publishProfile({ name: "Old", picture: "" }, {}),
  ).rejects.toThrow("newer profile");
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
  expect(await f.setup.inspectProfile()).toMatchObject({
    exists: true,
    profile: { name: "New" },
  });
});
it("an accepted receipt without current profile evidence does not complete setup", async () => {
  const f = fixture();
  f.publish.mockImplementation(async () => {});
  await expect(
    f.setup.publishProfile({ name: "New", picture: "" }, {}),
  ).rejects.toThrow("not confirmed as the current profile");
  await expect(
    f.setup.publishProfile({ name: "New", picture: "" }, {}),
  ).rejects.toThrow("not confirmed as the current profile");
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(f.publish).toHaveBeenCalledTimes(1);
});
it("failed hydration is not an empty journal and cannot create a replacement", async () => {
  const f = fixture({
    load: () => Promise.reject(new Error("broken storage")),
    save: () => {},
  });
  await expect(
    f.setup.publishProfile({ name: "New", picture: "" }, {}),
  ).rejects.toThrow("Could not load the outbox");
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
it("the setup accessor reuses the exact session/outbox after local membership commit", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const f = fixture();
  const status: IdentityStatus = {
    state: "ready",
    pubkey: key.pubkey,
    generation: "2",
    revocation: "11111111-1111-4111-8111-111111111111",
    busy: false,
    reason: null,
  };
  let accessor: (() => ReturnType<typeof f.acquire>) | undefined;
  const source: CommunityIdentitySource = {
    snapshot: () => status,
    subscribe: () => () => {},
    connect: vi.fn(async () => f.transport),
    setup(_identity, _id, account, session) {
      accessor = session;
      return {
        ...createSetupProfile(session, account),
        info: async () => ({ policy: null }),
        acceptPolicy: async () => ({ receipt: "receipt" }),
        claim: async () => ({ status: "joined" }),
      };
    },
  };
  const root = new Context();
  roots.push(root);
  const client = createCommunities(root, true, source);
  client.setup("https://one.example", client.capture());
  assert.exists(accessor);
  const before = await accessor();
  expect(client.snapshot()).toMatchObject({ memberships: [], selected: null });
  client.joined(
    { id: "https://one.example", name: "One" },
    { name: "New", picture: "" },
    client.capture(),
  );
  expect(client.relay.snapshot().session).toBe(before);
  expect(client.relay.snapshot().session.outbox).toBe(before.outbox);
  expect(source.connect).toHaveBeenCalledTimes(1);
});

it("does not return profile evidence if a reconciliation observer retires the session", async () => {
  const event = profile(key, { name: "Saved", picture: "" }, 100);
  const f = fixture({
    load: () => [{ event, signed: event, delivery: "unknown" }],
    save: () => {},
  });
  const session = await f.acquire();
  f.setCurrent(event);
  session.outbox?.subscribe(() => f.store.dispose());
  await expect(session.ownProfile()).rejects.toThrow();
});

it("own-profile confirmation cannot join a read admitted before the action", async () => {
  const f = fixture();
  const session = await f.acquire();
  let release!: (events: RelayEvent[]) => void;
  vi.mocked(f.transport.query).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const earlier = session.read([
    { kinds: [0], authors: [key.pubkey], limit: 5 },
  ]);
  const current = profile(key, { name: "New", picture: "" }, 200);
  f.setCurrent(current);
  const confirmation = session.ownProfile();
  await flush();
  release([]);
  await earlier;
  expect((await confirmation)?.id).toBe(current.id);
  expect(f.transport.query).toHaveBeenCalledTimes(2);
});
