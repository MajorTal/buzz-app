// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { nativeIdentityEnabled } from "../../features/identity/service";
import type { RelayData } from "../../features/relay/service";
import { CommunityAdmin } from "./CommunityAdmin";
import { apply } from "./index";

const { relayKey } = vi.hoisted(() => ({ relayKey: "f".repeat(64) }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected native call");
  }),
  isTauri: () => true,
}));

const owner = "0".repeat(64);
const admin = "1".repeat(64);
const member = "2".repeat(64);
const snapshot = () => ({
  id: "e".repeat(64),
  kind: 13534,
  pubkey: relayKey,
  created_at: 1,
  content: "",
  sig: "",
  tags: [
    ["-"],
    ["member", owner, "owner"],
    ["member", admin, "admin"],
    ["member", member, "member"],
  ],
});

function relay(viewer: string) {
  const read = vi.fn(async () => [snapshot()]);
  const profiles = new Map<string, { name: string }>();
  const session = {
    relayAuthor: relayKey,
    read,
    viewer,
    media: () => undefined,
    directMessages: { people: async () => ({ people: [], hasMore: false }) },
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: async () => {},
    },
  };
  const value = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${viewer}`,
    viewer,
    session,
  };
  return {
    read,
    relay: {
      snapshot: () => value,
      subscribe: () => () => {},
    } as unknown as RelayData,
  };
}

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  // Native builds ship no broker; any fetch would be a routing mistake.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected broker request");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(invoke).mockClear();
});

it("keeps the Membership card registered in a native build", () => {
  expect(nativeIdentityEnabled()).toBe(true);
  const settingsCards = { register: vi.fn() };
  apply({
    relay: relay(owner).relay,
    settingsCards,
    effect: vi.fn(),
  } as unknown as Parameters<typeof apply>[0]);
  expect(settingsCards.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "membership",
      title: "Membership",
      section: "administration",
      component: expect.any(Function),
    }),
  );
});

it.each([owner, admin])(
  "lets a native manager %s mint invites without member-change controls",
  async (viewer) => {
    const user = userEvent.setup();
    expect(nativeIdentityEnabled()).toBe(true);
    const { relay: data, read } = relay(viewer);
    const url = "https://primary.example/invite/native";
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      expect(command).toBe("relay_http");
      expect(args).toEqual({
        community: "https://primary.example",
        path: "/api/invites",
        method: "POST",
        body: JSON.stringify({ ttl_secs: 3 * 24 * 60 * 60, max_uses: null }),
      });
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ code: "native", url }),
      };
    });
    render(<CommunityAdmin relay={data} active={() => true} />);
    const list = await screen.findByRole("list", { name: "Members" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(
      screen.getByText(
        "This build can’t change members, but you can share an invite link.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Invite members" }),
    ).toBeVisible();
    expect(screen.queryAllByRole("button", { name: /^Actions for / })).toEqual(
      [],
    );
    // The list stays live: Refresh re-reads the roster through the session.
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(invoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Invite members" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite people" });
    expect(await within(dialog).findByDisplayValue(url)).toBeVisible();
    expect(
      within(dialog).queryByRole("textbox", { name: "Public identity" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "Add member" }),
    ).toBeNull();
    expect(invoke).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  },
);
