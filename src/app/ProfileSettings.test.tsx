import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { ProfileSettings } from "./ProfileSettings";
import { ProfileFields } from "../features/communities/ProfileFields";
import type {
  Communities,
  CommunityAccount,
  ClientSnapshot,
  PersonalProfile,
} from "../features/communities/service";

// Execute the real form handlers and production child key. DOM/layout is deferred.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  writes: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const slots = hooks.slots,
      i = hooks.index++;
    if (!(i in slots))
      slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      slots[i],
      (value: unknown) => {
        hooks.writes.push(value);
        slots[i] = value;
      },
    ];
  },
  useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot(),
}));
const A = "a".repeat(64),
  B = "b".repeat(64);
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
    profile: { name: "Default A", picture: "" },
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
  const capture = vi.fn(() => {
    assertCurrent(account);
    return account;
  });
  const committed = vi.fn();
  const listeners = new Set<() => void>();
  const saveProfile = vi.fn(
    (profile: PersonalProfile, captured: CommunityAccount) => {
      assertCurrent(captured);
      committed(profile, captured);
      state = { ...state, profile };
      for (const listener of listeners) listener();
    },
  );
  const communities = {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    capture,
    assertCurrent,
    saveProfile,
  } as unknown as Communities;
  return {
    communities,
    capture,
    saveProfile,
    committed,
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
        status: "ready",
        profile: { name: "Replacement default", picture: "" },
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
    unrelated() {
      state = { ...state, selected: "https://example.com" };
    },
  };
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function mount(communities: Communities) {
  let key: string | null | undefined;
  let slots: unknown[] = [];
  let hidden = false;
  const render = () => {
    const outer = ProfileSettings({ communities });
    const child = elements(outer).find((e) => typeof e.type === "function");
    if (!child) {
      slots = [];
      key = undefined;
      return outer;
    }
    if (key !== child.key) {
      slots = [];
      key = child.key;
    }
    hooks.slots = slots;
    hooks.index = 0;
    const tree = (
      child.type as (props: Record<string, unknown>) => ReactElement
    )(child.props);
    // Settings hides this subtree instead of unmounting it when switching sections.
    return <div hidden={hidden}>{tree}</div>;
  };
  const find = (
    predicate: (e: ReactElement<Record<string, unknown>>) => boolean,
  ) => {
    const item = elements(render()).find(predicate);
    if (!item) throw new Error("Missing form element");
    return item;
  };
  return {
    render,
    hide(value: boolean) {
      hidden = value;
      render();
    },
    profile() {
      return find((e) => e.type === ProfileFields).props.profile;
    },
    change(name: string) {
      (
        find((e) => e.type === ProfileFields).props.onChange as (
          profile: PersonalProfile,
        ) => void
      )({ name, picture: "" });
    },
    submit() {
      (
        find((e) => e.type === "form").props.onSubmit as (
          event: unknown,
        ) => void
      )({ preventDefault() {} });
    },
    savedSubmit() {
      return find((e) => e.type === "form").props.onSubmit as (
        event: unknown,
      ) => void;
    },
    cancel() {
      (
        find((e) => e.type === "button" && e.props.children === "Cancel").props
          .onClick as () => void
      )();
    },
  };
}
beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
  hooks.writes = [];
});
it("preserves the current-account draft across hidden tabs and unrelated owner updates", () => {
  const host = owner(),
    ui = mount(host.communities);
  ui.change("Unsaved A");
  ui.hide(true);
  host.unrelated();
  ui.render();
  ui.hide(false);
  expect(ui.profile()).toEqual({ name: "Unsaved A", picture: "" });
  expect(host.capture).toHaveBeenCalledTimes(1);
  ui.submit();
  expect(host.committed).toHaveBeenCalledExactlyOnceWith(
    { name: "Unsaved A", picture: "" },
    host.account,
  );
});
it.each([B, A])(
  "resets hidden Profile Settings on replacement %s, not just a pubkey change",
  (viewer) => {
    const host = owner(),
      ui = mount(host.communities);
    ui.change("Secret A draft");
    ui.hide(true);
    host.replace(viewer);
    ui.render();
    ui.hide(false);
    expect(ui.profile()).toEqual({ name: "Replacement default", picture: "" });
    expect(host.capture).toHaveBeenCalledTimes(2);
    ui.submit();
    expect(host.committed).toHaveBeenCalledExactlyOnceWith(
      { name: "Replacement default", picture: "" },
      host.account,
    );
  },
);
it.each([B, A])(
  "a retained submit callback cannot save A's draft into replacement %s before rerender",
  (viewer) => {
    const host = owner(),
      ui = mount(host.communities);
    ui.change("Old draft");
    const submit = ui.savedSubmit(),
      old = host.account;
    host.replace(viewer);
    submit({ preventDefault() {} });
    expect(host.capture).toHaveBeenCalledTimes(1);
    expect(host.saveProfile).toHaveBeenCalledExactlyOnceWith(
      { name: "Old draft", picture: "" },
      old,
    );
    expect(host.committed).not.toHaveBeenCalled();
    expect(ui.profile()).toEqual({ name: "Replacement default", picture: "" });
  },
);
it.each([B, A])(
  "does not report success when a save observer retires the account to %s",
  (viewer) => {
    const host = owner(),
      ui = mount(host.communities);
    ui.change("Saved A draft");
    const old = host.account;
    host.communities.subscribe(() => host.replace(viewer));
    hooks.writes = [];
    ui.submit();
    expect(host.committed).toHaveBeenCalledExactlyOnceWith(
      { name: "Saved A draft", picture: "" },
      old,
    );
    expect(old.signal.aborted).toBe(true);
    expect(host.capture).toHaveBeenCalledTimes(1);
    // Inspect the retired handler's state writes before the keyed rerender can
    // mask a false success. This is not evidence of a visible browser message.
    expect(hooks.writes).toContain("Account changed");
    expect(hooks.writes).not.toContain(true);
    expect(hooks.writes).not.toContain(null);
    expect(ui.profile()).toEqual({ name: "Replacement default", picture: "" });
  },
);
it("unavailability removes the draft; reconnecting the same key cannot restore it", () => {
  const host = owner(),
    ui = mount(host.communities);
  ui.change("Do not resurrect");
  host.unavailable();
  expect(elements(ui.render()).some((e) => e.type === ProfileFields)).toBe(
    false,
  );
  host.replace(A);
  expect(ui.profile()).toEqual({ name: "Replacement default", picture: "" });
});
it("save and cancel stay local and reuse the current captured account", () => {
  const host = owner(),
    ui = mount(host.communities);
  ui.change("  Saved name  ");
  ui.submit();
  expect(host.committed).toHaveBeenCalledExactlyOnceWith(
    { name: "Saved name", picture: "" },
    host.account,
  );
  ui.change("Discard");
  ui.cancel();
  expect(ui.profile()).toEqual({ name: "Saved name", picture: "" });
  expect(host.capture).toHaveBeenCalledTimes(1);
});
