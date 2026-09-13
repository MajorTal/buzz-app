import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { CommunityDialog } from "./CommunityDialog";
import { CommunitySwitcher } from "./CommunitySwitcher";
import { ProfileFields } from "./ProfileFields";
import type {
  Communities,
  CommunityAccount,
  ClientSnapshot,
  PersonalProfile,
} from "./service";
import { ReadError } from "../relay/errors";
import { communityRequest, inspectProfile, publishProfile } from "./api";
import { registerBrokerCommunity } from "../relay/transport";

// Production handlers and their keyed draft lifetimes; not browser layout/focus evidence.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as (() => undefined | (() => void))[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const slots = hooks.slots;
    const i = hooks.index++;
    if (!(i in slots))
      slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      slots[i],
      (value: unknown) => {
        slots[i] = typeof value === "function" ? value(slots[i]) : value;
      },
    ];
  },
  useRef(initial: unknown) {
    const i = hooks.index++;
    hooks.slots[i] ??= { current: initial };
    return hooks.slots[i];
  },
  useEffect(effect: () => undefined | (() => void), deps: unknown[]) {
    const i = hooks.index++;
    const previous = hooks.slots[i] as unknown[] | undefined;
    if (!previous || deps.some((value, j) => !Object.is(value, previous[j])))
      hooks.effects.push(effect);
    hooks.slots[i] = deps;
  },
  useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("./api", () => ({
  communityRequest: vi.fn(),
  inspectProfile: vi.fn(),
  publishProfile: vi.fn(),
}));
vi.mock("../relay/transport", () => ({ registerBrokerCommunity: vi.fn() }));
const A = "a".repeat(64),
  B = "b".repeat(64);
const remote = {
  exists: true,
  profile: { name: "Remote A", picture: "" },
  existing: { about: "preserved" },
};
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function owner() {
  let controller = new AbortController();
  let account: CommunityAccount = {
    viewer: A,
    epoch: 1,
    signal: controller.signal,
  };
  let state: ClientSnapshot = {
    status: "ready",
    viewer: A,
    epoch: 1,
    profile: { name: "Local A", picture: "" },
    memberships: [],
    selected: null,
  };
  const assertCurrent = vi.fn((captured: CommunityAccount) => {
    if (
      captured !== account ||
      captured.signal.aborted ||
      state.status !== "ready"
    )
      throw new Error("Account changed");
  });
  const joined = vi.fn(
    (
      _membership: unknown,
      _profile: PersonalProfile,
      captured: CommunityAccount,
    ) => assertCurrent(captured),
  );
  const saveProfile = vi.fn(
    (_profile: PersonalProfile, captured: CommunityAccount) =>
      assertCurrent(captured),
  );
  const capture = vi.fn(() => {
    assertCurrent(account);
    return account;
  });
  const communities = {
    snapshot: () => state,
    subscribe: () => () => {},
    capture,
    assertCurrent,
    joined,
    saveProfile,
    select: vi.fn(),
  } as unknown as Communities;
  return {
    communities,
    capture,
    joined,
    saveProfile,
    get account() {
      return account;
    },
    replace(viewer = B) {
      controller.abort();
      controller = new AbortController();
      account = { viewer, epoch: account.epoch + 1, signal: controller.signal };
      state = {
        ...state,
        viewer,
        epoch: account.epoch,
        profile: { name: "New account default", picture: "" },
      };
    },
    unavailable() {
      controller.abort();
      state = {
        ...state,
        epoch: state.epoch + 1,
        status: "unavailable",
      };
    },
  };
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function call(
  element: ReactElement<Record<string, unknown>>,
  handler: string,
  event: unknown = { preventDefault() {} },
) {
  (element.props[handler] as (event: unknown) => void)(event);
}
function mount(communities: Communities, mode: "join" | "profile" = "join") {
  let key: string | null | undefined;
  let slots: unknown[] = [];
  let cleanups: (() => void)[] = [];
  const close = vi.fn(),
    onJoined = vi.fn();
  const render = () => {
    const child = CommunityDialog({ communities, mode, close, onJoined });
    if (key !== child.key) {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      slots = [];
      key = child.key;
    }
    hooks.slots = slots;
    hooks.index = 0;
    const tree = (
      child.type as (props: Record<string, unknown>) => ReactElement
    )(child.props);
    for (const effect of hooks.effects.splice(0)) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    return tree;
  };
  const find = (
    predicate: (e: ReactElement<Record<string, unknown>>) => boolean,
  ) => {
    const item = elements(render()).find(predicate);
    if (!item) throw new Error("Element missing");
    return item;
  };
  return {
    render,
    close,
    onJoined,
    find,
    url(value: string) {
      call(
        find((e) => e.type === "input" && e.props.type === "url"),
        "onChange",
        { target: { value } },
      );
    },
    profile(name: string) {
      call(
        find((e) => e.type === ProfileFields),
        "onChange",
        { name, picture: "" },
      );
    },
    submit() {
      call(
        find((e) => e.type === "form"),
        "onSubmit",
      );
    },
    unmount() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
  hooks.effects = [];
  vi.clearAllMocks();
  vi.mocked(registerBrokerCommunity).mockResolvedValue(undefined);
  vi.mocked(communityRequest).mockResolvedValue({
    name: "Test community",
    policy: null,
  });
  vi.mocked(inspectProfile).mockResolvedValue(remote);
  vi.mocked(publishProfile).mockResolvedValue(undefined);
});
it("captures once and commits an unchanged existing profile without publication", async () => {
  const host = owner(),
    ui = mount(host.communities);
  ui.url("wss://example.com");
  ui.submit();
  await flush();
  ui.submit();
  await flush();
  expect(host.capture).toHaveBeenCalledTimes(1);
  expect(host.joined).toHaveBeenCalledExactlyOnceWith(
    { id: "https://example.com", name: "Test community" },
    remote.profile,
    host.account,
  );
  expect(publishProfile).not.toHaveBeenCalled();
  expect(communityRequest).toHaveBeenCalledExactlyOnceWith(
    "https://example.com",
    "info",
    undefined,
    host.account,
  );
  expect(inspectProfile).toHaveBeenCalledExactlyOnceWith(
    "https://example.com",
    host.account,
  );
  expect(ui.onJoined).toHaveBeenCalledExactlyOnceWith("https://example.com");
  expect(ui.close).toHaveBeenCalledTimes(1);
});
it.each([B, A])(
  "retires and clears dialog input for replacement %s, including same-key epochs",
  async (viewer) => {
    const host = owner(),
      ui = mount(host.communities);
    ui.url("wss://old.example.com");
    const oldSubmit = ui.find((e) => e.type === "form");
    const old = host.account;
    host.replace(viewer);
    expect(
      ui.find((e) => e.type === "input" && e.props.type === "url").props.value,
    ).toBe("");
    call(oldSubmit, "onSubmit");
    await flush();
    expect(old.signal.aborted).toBe(true);
    expect(registerBrokerCommunity).not.toHaveBeenCalled();
    expect(host.capture).toHaveBeenCalledTimes(2);
    expect(host.joined).not.toHaveBeenCalled();
    expect(ui.close).not.toHaveBeenCalled();
  },
);
it("aborts registration and stops the next request even before React rerenders", async () => {
  const pending = deferred<void>();
  vi.mocked(registerBrokerCommunity).mockReturnValueOnce(pending.promise);
  const host = owner(),
    ui = mount(host.communities);
  ui.url("wss://example.com");
  ui.submit();
  const signal = vi.mocked(registerBrokerCommunity).mock.calls[0]?.[1];
  host.replace();
  expect(signal?.aborted).toBe(true);
  pending.resolve();
  await flush();
  expect(communityRequest).not.toHaveBeenCalled();
  expect(ui.close).not.toHaveBeenCalled();
});
it("a delayed inspected profile cannot populate the replacement account's draft", async () => {
  const pending = deferred<typeof remote>();
  vi.mocked(inspectProfile).mockReturnValueOnce(pending.promise);
  const host = owner(),
    ui = mount(host.communities);
  ui.url("wss://example.com");
  ui.submit();
  await flush();
  host.replace();
  ui.render();
  pending.resolve(remote);
  await flush();
  expect(elements(ui.render()).some((e) => e.type === ProfileFields)).toBe(
    false,
  );
  expect(host.joined).not.toHaveBeenCalled();
  expect(ui.onJoined).not.toHaveBeenCalled();
});
it.each([B, A])(
  "publication completion after retirement to %s cannot join, navigate or close",
  async (viewer) => {
    const pending = deferred<void>();
    vi.mocked(publishProfile).mockReturnValueOnce(pending.promise);
    const host = owner(),
      ui = mount(host.communities);
    ui.url("wss://example.com");
    ui.submit();
    await flush();
    ui.profile("Edited A");
    ui.submit();
    await flush();
    expect(publishProfile).toHaveBeenCalledExactlyOnceWith(
      "https://example.com",
      { name: "Edited A", picture: "" },
      remote.existing,
      host.account,
    );
    host.replace(viewer); // Intentionally do not rerender: the authority guard must suffice.
    pending.resolve();
    await flush();
    expect(host.joined).not.toHaveBeenCalled();
    expect(ui.onJoined).not.toHaveBeenCalled();
    expect(ui.close).not.toHaveBeenCalled();
  },
);
it("unmount fences late publication even while the account is still current", async () => {
  const pending = deferred<void>();
  vi.mocked(publishProfile).mockReturnValueOnce(pending.promise);
  const host = owner(),
    ui = mount(host.communities);
  ui.url("wss://example.com");
  ui.submit();
  await flush();
  ui.profile("Edit");
  ui.submit();
  ui.unmount();
  pending.resolve();
  await flush();
  expect(host.joined).not.toHaveBeenCalled();
  expect(ui.close).not.toHaveBeenCalled();
});
it("rechecks after joined observers and after onJoined before closing", async () => {
  const host = owner(),
    ui = mount(host.communities);
  ui.url("wss://example.com");
  ui.submit();
  await flush();
  host.joined.mockImplementationOnce(() => host.replace());
  ui.submit();
  await flush();
  expect(ui.onJoined).not.toHaveBeenCalled();
  expect(ui.close).not.toHaveBeenCalled();
  const next = mount(host.communities);
  next.url("wss://example.com");
  next.submit();
  await flush();
  next.onJoined.mockImplementationOnce(() => host.replace());
  next.submit();
  await flush();
  expect(next.onJoined).toHaveBeenCalledTimes(1);
  expect(next.close).not.toHaveBeenCalled();
});
it("a captured local profile dialog cannot save an old draft into B", async () => {
  const host = owner(),
    ui = mount(host.communities, "profile");
  ui.profile("Private draft A");
  const form = ui.find((e) => e.type === "form");
  host.replace();
  call(form, "onSubmit");
  await flush();
  expect(host.saveProfile).not.toHaveBeenCalled();
  expect(ui.close).not.toHaveBeenCalled();
  expect(ui.find((e) => e.type === ProfileFields).props.profile).toEqual({
    name: "New account default",
    picture: "",
  });
});
it.each(["unavailable", "invalid-response"] as const)(
  "does not treat %s profile inspection as absence",
  async (kind) => {
    vi.mocked(inspectProfile).mockRejectedValueOnce(
      new ReadError(kind, "Profile read failed"),
    );
    const host = owner(),
      ui = mount(host.communities);
    ui.url("wss://example.com");
    ui.submit();
    await flush();
    expect(ui.find((e) => e.props.role === "alert").props.children).toBe(
      "Profile read failed",
    );
    expect(
      ui.find((e) => e.type === "input" && e.props.type === "url").props.value,
    ).toBe("wss://example.com");
    expect(host.joined).not.toHaveBeenCalled();
    expect(publishProfile).not.toHaveBeenCalled();
  },
);
it("explicit denied discovery allows admission, but does not confirm an absent profile", async () => {
  vi.mocked(inspectProfile).mockRejectedValueOnce(
    new ReadError("denied", "No access", 403),
  );
  const host = owner(),
    ui = mount(host.communities);
  ui.url("wss://example.com");
  ui.submit();
  await flush();
  expect(
    elements(ui.render()).some(
      (e) =>
        e.type === "input" &&
        e.props.placeholder === "Existing members can leave this blank",
    ),
  ).toBe(true);
  ui.submit();
  await flush();
  expect(inspectProfile).toHaveBeenCalledTimes(2);
  expect(ui.find((e) => e.type === ProfileFields).props.profile).toEqual(
    remote.profile,
  );
  expect(publishProfile).not.toHaveBeenCalled();
});
it.each([B, A])(
  "switcher retires the open join dialog and stale selection for %s",
  (viewer) => {
    const host = owner(),
      onSelect = vi.fn();
    const render = () => {
      hooks.index = 0;
      return CommunitySwitcher({ communities: host.communities, onSelect });
    };
    const find = (
      predicate: (e: ReactElement<Record<string, unknown>>) => boolean,
    ) => {
      const element = elements(render()).find(predicate);
      if (!element) throw new Error("Missing switcher element");
      return element;
    };
    const oldPersonal = find((e) => e.props["aria-label"] === "Personal space");
    const oldDialogKey = find((e) => e.type === "dialog").key;
    call(
      find((e) => e.props["aria-label"] === "Add a community"),
      "onClick",
    );
    expect(elements(render()).some((e) => e.type === CommunityDialog)).toBe(
      true,
    );
    host.replace(viewer);
    expect(elements(render()).some((e) => e.type === CommunityDialog)).toBe(
      false,
    );
    expect(find((e) => e.type === "dialog").key).not.toBe(oldDialogKey);
    call(oldPersonal, "onClick");
    expect(onSelect).not.toHaveBeenCalled();
    call(
      find((e) => e.props["aria-label"] === "Add a community"),
      "onClick",
    );
    expect(elements(render()).some((e) => e.type === CommunityDialog)).toBe(
      true,
    );
  },
);

it("a denied discovery followed by policy/claim/profile work retains the original account", async () => {
  vi.mocked(communityRequest)
    .mockResolvedValueOnce({
      name: "Test community",
      policy: { version: "v1", age_attestation_required: false },
    })
    .mockResolvedValueOnce({ receipt: "receipt" })
    .mockResolvedValueOnce({ status: "joined" });
  vi.mocked(inspectProfile).mockRejectedValueOnce(
    new ReadError("denied", "No access", 403),
  );
  const host = owner(),
    ui = mount(host.communities);
  ui.url("wss://example.com");
  ui.submit();
  await flush();
  call(
    ui.find(
      (e) =>
        e.type === "input" &&
        e.props.placeholder === "Existing members can leave this blank",
    ),
    "onChange",
    { target: { value: "invite" } },
  );
  ui.submit();
  await flush();
  expect(communityRequest).toHaveBeenNthCalledWith(
    2,
    "https://example.com",
    "accept-policy",
    { code: "invite", policy_version: "v1", age_confirmed: false },
    host.account,
  );
  expect(communityRequest).toHaveBeenNthCalledWith(
    3,
    "https://example.com",
    "claim",
    { code: "invite", policy_receipt: "receipt" },
    host.account,
  );
  expect(inspectProfile).toHaveBeenLastCalledWith(
    "https://example.com",
    host.account,
  );
  expect(host.capture).toHaveBeenCalledTimes(1);
});
it.each(["info", "accept-policy", "claim"])(
  "retirement while %s is pending stops subsequent admission/profile work",
  async (route) => {
    const pending = deferred<unknown>();
    vi.mocked(communityRequest).mockImplementation((_id, requested) => {
      if (requested === route)
        return pending.promise as ReturnType<typeof communityRequest>;
      return Promise.resolve(
        requested === "info"
          ? {
              name: "Test community",
              policy: { version: "v1", age_attestation_required: false },
            }
          : { receipt: "receipt", status: "joined" },
      ) as ReturnType<typeof communityRequest>;
    });
    vi.mocked(inspectProfile).mockRejectedValueOnce(
      new ReadError("denied", "No access", 403),
    );
    const host = owner(),
      ui = mount(host.communities);
    ui.url("wss://example.com");
    ui.submit();
    await flush();
    if (route !== "info") {
      call(
        ui.find(
          (e) =>
            e.type === "input" &&
            e.props.placeholder === "Existing members can leave this blank",
        ),
        "onChange",
        { target: { value: "invite" } },
      );
      ui.submit();
      await flush();
    }
    const calls = vi.mocked(communityRequest).mock.calls.length;
    const reads = vi.mocked(inspectProfile).mock.calls.length;
    host.replace();
    pending.resolve({ receipt: "receipt", status: "joined" });
    await flush();
    expect(communityRequest).toHaveBeenCalledTimes(calls);
    expect(inspectProfile).toHaveBeenCalledTimes(reads);
    expect(host.joined).not.toHaveBeenCalled();
    expect(ui.close).not.toHaveBeenCalled();
  },
);
