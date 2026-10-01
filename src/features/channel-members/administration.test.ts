import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import type { RelayEvent } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import { createRelaySession } from "../relay/session";
import { matchesEvent } from "../relay/projection";
import { sessionDescription } from "../sessions/metadata";
import { createMemberAdministration } from "./administration";
import {
  memberAuthority,
  validateMemberAdministrationTemplate,
  type MemberChange,
} from "./administration-protocol";

const key = new Uint8Array(32).fill(2);
const relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  author = getPublicKey(relayKey);
const target = getPublicKey(new Uint8Array(32).fill(4));
const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const change: MemberChange = {
  pubkey: target,
  expectedRole: "member",
  role: "admin",
};
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(actor = "owner", role: string | undefined = "member") {
  let clock = 100;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent({ kind, tags, content: "", created_at: clock++ }, relayKey);
  const roster = (actor: string, role: string | undefined) => [
    record(39001, [
      ["d", id],
      ...[
        [viewer, actor],
        [target, role],
      ]
        .filter(([, role]) => role === "owner" || role === "admin")
        .map(([key, role]) => ["p", key ?? "", role ?? ""]),
    ]),
    record(39002, [
      ["d", id],
      ["p", viewer, "", actor],
      ...(role === undefined ? [] : [["p", target, "", role]]),
    ]),
  ];
  let events = [
    record(39000, [
      ["d", id],
      ["t", "stream"],
      ["private"],
      ["name", "Fixture"],
    ]),
    ...roster(actor, role),
  ];
  let access = true;
  const read = vi.fn(async (_filters?: unknown, _options?: unknown) => events);
  const sign = vi.fn(async (template: EventTemplate) =>
    finalizeEvent(structuredClone(template), key),
  );
  const publish = vi.fn(async (event: RelayEvent) => {
    events = [
      required(events[0]),
      ...roster(
        actor,
        event.kind === 9001
          ? undefined
          : event.tags.find(([tag]) => tag === "role")?.[1],
      ),
    ];
  });
  const acceptDiscovery = vi.fn();
  const owner = createMemberAdministration({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor: author,
    canAccess: () => access,
    acceptDiscovery,
  });
  stops.push(owner.dispose);
  return {
    owner,
    read,
    sign,
    publish,
    acceptDiscovery,
    record,
    events: () => events,
    setEvents: (next: RelayEvent[]) => {
      events = next;
    },
    setRoles: (actor: string, role?: string) => {
      events = [required(events[0]), ...roster(actor, role)];
    },
    deny: () => {
      access = false;
    },
  };
}

it.each(["admin", "member", "guest", "remove"] as const)(
  "confirms %s from exact fresh signed state, never acknowledgement alone",
  async (role) => {
    const h = harness("admin", role === "member" ? "guest" : "member");
    const expectedRole = role === "member" ? "guest" : "member";
    await h.owner.capability.refresh(id);
    await h.owner.capability.run(id, { ...change, role, expectedRole });
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.read).toHaveBeenCalledTimes(4);
    expect(h.read.mock.calls[0]).toEqual([
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        authors: [author],
        "#d": [id],
        limit: 1,
      })),
      expect.objectContaining({ fresh: true, priority: "foreground" }),
    ]);
  },
);
it.each(["owner", "bot", "unknown"])(
  "never coerces %s target roles",
  async (role) => {
    const h = harness("owner", role);
    await h.owner.capability.run(id, change);
    expect(h.sign).not.toHaveBeenCalled();
  },
);
it("allows removing a bot without changing its role or invoking agent deletion", async () => {
  const h = harness("owner", "bot");
  await h.owner.capability.run(id, {
    ...change,
    expectedRole: "bot",
    role: "remove",
  });
  expect(h.publish.mock.calls[0]?.[0]).toMatchObject({
    kind: 9001,
    tags: [
      ["h", id],
      ["p", target],
    ],
  });
});
it.each(["member", "guest", "bot"])(
  "never grants administration to %s viewers",
  async (role) => {
    const h = harness(role);
    await h.owner.capability.run(id, change);
    expect(h.sign).not.toHaveBeenCalled();
  },
);
it("protects all owners and self even when co-owners exist", async () => {
  const h = harness("owner", "owner");
  for (const pubkey of [target, viewer]) {
    await h.owner.capability.run(id, {
      pubkey,
      expectedRole: "owner",
      role: "remove",
    });
  }
  expect(h.sign).not.toHaveBeenCalled();
});
it.each(["dm", "archived", "session"])("excludes %s channels", async (kind) => {
  const h = harness();
  h.setEvents([
    h.record(39000, [
      ["d", id],
      ["t", kind === "dm" ? "dm" : "stream"],
      ...(kind === "archived" ? [["archived", "true"]] : []),
      ...(kind === "session" ? [["about", sessionDescription()]] : []),
    ]),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.run(id, change);
  expect(h.sign).not.toHaveBeenCalled();
});
it.each([
  "missing",
  "foreign",
  "channel",
  "duplicate",
  "inconsistent",
  "unexpected",
])("fails closed on %s authority", async (failure) => {
  const h = harness();
  const events = h.events();
  if (failure === "missing") events.pop();
  if (failure === "foreign")
    events[1] = { ...required(events[1]), pubkey: target };
  if (failure === "channel")
    events[1] = h.record(39001, [
      ["d", otherId],
      ["p", viewer, "owner"],
    ]);
  if (failure === "duplicate")
    events[2] = h.record(39002, [
      ["d", id],
      ["p", viewer, "", "owner"],
      ["p", viewer, "", "owner"],
    ]);
  if (failure === "inconsistent") events[1] = h.record(39001, [["d", id]]);
  if (failure === "unexpected") events.push(h.record(9, [["h", id]]));
  await h.owner.capability.run(id, change);
  expect(h.sign).not.toHaveBeenCalled();
});
it("does not fabricate Member for missing or unknown role hints", () => {
  const h = harness();
  h.setEvents([
    required(h.events()[0]),
    required(h.events()[1]),
    h.record(39002, [
      ["d", id],
      ["p", viewer, "", "owner"],
      ["p", target],
    ]),
  ]);
  expect(memberAuthority(h.events(), id, viewer, author).roles[target]).toBe(
    "unknown",
  );
});
it.each(["actor", "target", "removed", "access"])(
  "rechecks %s after signing, before publishing",
  async (what) => {
    const h = harness();
    h.sign.mockImplementationOnce(async (template) => {
      if (what === "actor") h.setRoles("member", "member");
      if (what === "target") h.setRoles("owner", "owner");
      if (what === "removed") h.setRoles("owner");
      if (what === "access") h.deny();
      return finalizeEvent(template, key);
    });
    await h.owner.capability.run(id, change);
    expect(h.publish).not.toHaveBeenCalled();
  },
);
it("rejects altered signer payloads", async () => {
  const h = harness();
  h.sign.mockImplementationOnce(async (template) =>
    finalizeEvent({ ...template, content: "changed" }, key),
  );
  await h.owner.capability.run(id, change);
  expect(h.publish).not.toHaveBeenCalled();
});
it.each(["ack", "lost", "read"])(
  "retains roles on %s uncertainty and preserves readback-only recovery through clear",
  async (failure) => {
    const h = harness();
    await h.owner.capability.refresh(id);
    h.publish.mockImplementationOnce(async () => {
      if (failure === "lost") throw new Error("Connection lost");
      if (failure === "read")
        h.read.mockRejectedValueOnce(new Error("Offline"));
    });
    await h.owner.capability.run(id, change);
    expect(h.owner.capability.snapshot(id)).toMatchObject({
      authority: { roles: { [target]: "member" } },
      operation: { status: "uncertain" },
    });
    h.owner.clear();
    expect(h.owner.capability.snapshot(id)).toMatchObject({
      authority: { roles: {}, canManage: false },
      operation: { change, status: "uncertain" },
    });
    await expect(h.owner.capability.run(id, change)).rejects.toThrow(
      /not be sent again/,
    );
    await h.owner.capability.refresh(id);
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("uncertain");
    h.setRoles("owner", "admin");
    await h.owner.capability.refresh(id);
    expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
    expect(h.publish).toHaveBeenCalledOnce();
  },
);
it("preserves confirmed roles on rejection and requires fresh explicit intent", async () => {
  const h = harness();
  await h.owner.capability.refresh(id);
  h.publish.mockRejectedValueOnce(new PublishRejected("Not permitted"));
  await h.owner.capability.run(id, change);
  expect(h.owner.capability.snapshot(id)).toMatchObject({
    status: "error",
    error: "Not permitted",
    operation: { status: "failed" },
    authority: { roles: { [target]: "member" } },
  });
});
it.each(["access", "invalid ID"])(
  "settles a %s preflight failure instead of leaving role consumers idle",
  async (failure) => {
    const h = harness();
    if (failure === "access") h.deny();
    const channelId = failure === "invalid ID" ? "one" : id;
    await h.owner.capability.refresh(channelId);
    expect(h.owner.capability.snapshot(channelId)).toMatchObject({
      status: "error",
      authority: { roles: {}, canManage: false },
      error:
        failure === "access"
          ? "Channel access unavailable; refresh membership."
          : "Invalid channel ID",
    });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  },
);
it.each(["clear", "dispose"] as const)(
  "does not resurrect preflight errors after %s",
  async (end) => {
    const h = harness();
    h.deny();
    const pending = h.owner.capability.refresh(id);
    h.owner[end]();
    await pending;
    expect(h.owner.capability.snapshot(id)).toMatchObject({
      status: "idle",
      authority: { roles: {}, canManage: false },
    });
  },
);
it("retains confirmed roles on refresh failure", async () => {
  const h = harness();
  await h.owner.capability.refresh(id);
  h.read.mockRejectedValueOnce(new Error("Offline"));
  await h.owner.capability.refresh(id);
  expect(h.owner.capability.snapshot(id)).toMatchObject({
    status: "error",
    authority: { roles: { [target]: "member" } },
  });
});
it.each(["clear", "dispose"] as const)(
  "%s fences late publication completion",
  async (action) => {
    const h = harness();
    const gate = deferred();
    h.publish.mockImplementationOnce(() => gate.promise);
    const operation = h.owner.capability.run(id, change);
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
    await expect(h.owner.capability.run(id, change)).rejects.toThrow(
      /still in progress/,
    );
    h.owner[action]();
    gate.resolve();
    await operation;
    expect(h.owner.capability.snapshot(id).status).toBe("idle");
    expect(h.acceptDiscovery).not.toHaveBeenCalled();
  },
);
it("uses separate snapshots across channel destinations", async () => {
  const h = harness();
  await h.owner.capability.refresh(id);
  expect(h.owner.capability.snapshot(otherId).status).toBe("idle");
});
it("documents the accepted post-preflight departure race without promising atomic changes", async () => {
  const h = harness();
  const publish = required(h.publish.getMockImplementation());
  h.publish.mockImplementationOnce(async (event) => {
    h.setRoles("owner"); // Departure after final preflight; existing relay upsert re-adds.
    await publish(event);
  });
  await h.owner.capability.run(id, change);
  expect(h.owner.capability.snapshot(id).authority.roles[target]).toBe("admin");
});
it("unsupported adapters retain verified role reading but cannot sign", async () => {
  const h = harness();
  const owner = createMemberAdministration({
    reader: { read: h.read },
    viewer,
    relayAuthor: author,
    canAccess: () => true,
    acceptDiscovery: h.acceptDiscovery,
  });
  stops.push(owner.dispose);
  await owner.capability.refresh(id);
  expect(owner.capability.available).toBe(false);
  expect(owner.capability.snapshot(id).authority.roles[target]).toBe("member");
  await expect(owner.capability.run(id, change)).rejects.toThrow(/unavailable/);
});
it("binds the capability to production session discovery, cache clear and disposal", async () => {
  const h = harness();
  const sessionOwner = createRelaySession({
    viewer,
    relayAuthor: author,
    media: () => undefined,
    query: async (filters) =>
      h
        .events()
        .filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    memberAdministration: { sign: h.sign, publish: h.publish },
  });
  stops.push(sessionOwner.dispose);
  const session = sessionOwner.session;
  session.channels.ensureList();
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"));
  await session.memberAdministration.refresh(id);
  await session.memberAdministration.run(id, { ...change, role: "remove" });
  expect(session.channels.get?.(id)?.members).not.toContain(target);
  expect(session.memberAdministration.snapshot(id).operation?.status).toBe(
    "confirmed",
  );
  await sessionOwner.clearCache();
  expect(session.memberAdministration.snapshot(id).status).toBe("idle");
  sessionOwner.dispose();
  await expect(session.memberAdministration.run(id, change)).rejects.toThrow(
    /closed/,
  );
});
it("clears roles when the production session observes viewer access loss", async () => {
  const h = harness();
  const owner = createRelaySession({
    viewer,
    relayAuthor: author,
    media: () => undefined,
    query: async (filters) =>
      h
        .events()
        .filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    memberAdministration: { sign: h.sign, publish: h.publish },
  });
  stops.push(owner.dispose);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  await owner.session.memberAdministration.refresh(id);
  h.setEvents([
    required(h.events()[0]),
    h.record(39001, [["d", id]]),
    h.record(39002, [
      ["d", id],
      ["p", target, "", "member"],
    ]),
  ]);
  await owner.session.read([{ kinds: [39002], "#d": [id], limit: 1 }], {
    fresh: true,
  });
  expect(owner.session.memberAdministration.snapshot(id).status).toBe("idle");
  await expect(
    owner.session.memberAdministration.run(id, change),
  ).rejects.toThrow(/access unavailable/);
  expect(h.sign).not.toHaveBeenCalled();
});
it.each(["cache", "access"] as const)(
  "%s clearing preserves sent intent during publication and after uncertainty",
  async (end) => {
    const h = harness();
    const owner = createRelaySession({
      viewer,
      relayAuthor: author,
      media: () => undefined,
      query: async (filters) =>
        h
          .events()
          .filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
      memberAdministration: { sign: h.sign, publish: h.publish },
    });
    stops.push(owner.dispose);
    const session = owner.session;
    const admin = session.memberAdministration;
    const readRoster = () =>
      session.read([{ kinds: [39002], "#d": [id], limit: 1 }], { fresh: true });
    const clear = async () => {
      if (end === "cache") await owner.clearCache();
      else {
        h.setEvents([
          required(h.events()[0]),
          h.record(39001, [["d", id]]),
          h.record(39002, [
            ["d", id],
            ["p", target, "", "member"],
          ]),
        ]);
        await readRoster();
      }
    };
    const recoverAccess = async () => {
      h.setRoles("owner", "member");
      await readRoster();
    };
    session.channels.ensureList();
    await vi.waitFor(() =>
      expect(session.channels.list().status).toBe("ready"),
    );
    await admin.refresh(id);
    const gate = deferred();
    h.publish.mockImplementationOnce(() => gate.promise);
    const pending = admin.run(id, change);
    try {
      await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
      await clear();
      expect(admin.snapshot(id)).toMatchObject({
        status: "idle",
        authority: { roles: {}, canManage: false },
        operation: { change, status: "uncertain" },
      });
      await recoverAccess();
      await expect(admin.run(id, change)).rejects.toThrow(/not be sent again/);
      await admin.refresh(id);
      expect(admin.snapshot(id).operation?.status).toBe("uncertain");
      // Clearing the settled uncertain snapshot must retain the same fence too.
      await clear();
      expect(admin.snapshot(id).authority).toEqual({
        roles: {},
        canManage: false,
      });
      await recoverAccess();
      await expect(admin.run(id, change)).rejects.toThrow(/not be sent again/);
      // Fresh readback, not a response from the old publication, resolves it.
      h.setRoles("owner", "admin");
      await admin.refresh(id);
      expect(admin.snapshot(id).operation?.status).toBe("confirmed");
      const confirmed = admin.snapshot(id);
      gate.resolve();
      await pending;
      expect(admin.snapshot(id)).toBe(confirmed);
      expect(h.publish).toHaveBeenCalledOnce();
      expect(h.sign).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await pending;
    }
  },
);
it("clearing during signing cancels without retaining an unsent operation", async () => {
  const h = harness();
  const gate = deferred();
  h.sign.mockImplementationOnce(async (template) => {
    await gate.promise;
    return finalizeEvent(template, key);
  });
  const pending = h.owner.capability.run(id, change);
  try {
    await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
    h.owner.clear();
  } finally {
    gate.resolve();
    await pending;
  }
  expect(h.owner.capability.snapshot(id).operation).toBeUndefined();
  expect(h.publish).not.toHaveBeenCalled();
  await h.owner.capability.run(id, change);
  expect(h.owner.capability.snapshot(id).operation?.status).toBe("confirmed");
});
it("narrow validator rejects self-removal and arbitrary role/metadata payloads", () => {
  const base = {
    kind: 9000,
    created_at: 100,
    content: "",
    tags: [
      ["h", id],
      ["p", target],
      ["role", "admin"],
    ],
  };
  expect(() =>
    validateMemberAdministrationTemplate(base, viewer),
  ).not.toThrow();
  for (const invalid of [
    { ...base, kind: 9002 },
    { ...base, content: "extra" },
    {
      ...base,
      tags: [
        ["h", id],
        ["p", viewer],
        ["role", "member"],
      ],
    },
    ...["owner", "bot", ""].map((role) => ({
      ...base,
      tags: [
        ["h", id],
        ["p", target],
        ["role", role],
      ],
    })),
    { ...base, tags: [...base.tags, ["h", id]] },
  ])
    expect(() =>
      validateMemberAdministrationTemplate(invalid, viewer),
    ).toThrow();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
