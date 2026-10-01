// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import type { ClientSnapshot } from "../../features/communities/service";
import { createRelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
import { UnifiedInventory } from "./UnifiedInventory";

// A packaged desktop connection: the real adapter selection, with no broker.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  convertFileSrc: (url: string, protocol: string) =>
    `${protocol}://localhost/${encodeURIComponent(url)}`,
}));
const owner = keypair();
const agent = keypair();
const joined = "https://joined.example.test";
const picture = `${joined}/media/${"ab".repeat(32)}.png`;
const requests: { community: string; path: string; body: unknown }[] = [];
let unavailable = true;
beforeEach(() => {
  requests.length = 0;
  unavailable = true;
  vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No development broker in this build");
    }),
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return owner.pubkey;
    if (command !== "relay_http")
      throw new Error(`Unexpected native command ${command}`);
    const { community, path, body } = args as {
      community: string;
      path: string;
      body: string | null;
    };
    const filters = body ? JSON.parse(body) : undefined;
    requests.push({ community, path, body: filters });
    if (path !== "/query") throw new Error(`Unexpected relay path ${path}`);
    const [filter] = filters as { kinds: number[] }[];
    const events = filter?.kinds.includes(0)
      ? [
          signed(agent, {
            kind: 0,
            tags: [],
            content: JSON.stringify({ name: "Native scout", picture }),
          }),
        ]
      : [
          signed(owner, {
            kind: 30177,
            tags: [["d", agent.pubkey]],
            content: JSON.stringify({ name: "Scout" }),
          }),
        ];
    return unavailable && !filter?.kinds.includes(0)
      ? { status: 503, headers: {}, body: JSON.stringify({ error: "busy" }) }
      : { status: 200, headers: {}, body: JSON.stringify(events) };
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(invoke).mockReset();
});

it("discovers and retries an unselected joined community through native reads", async () => {
  const f = controlFixture();
  f.data.agents = [];
  f.data.parked = [];
  const control = createAgentControl(f.host);
  const owned = createRelaySession({
    viewer: owner.pubkey,
    relayAuthor: "ef".repeat(32),
    scope: "wss://relay.example.test",
    query: async () => [],
    media: () => undefined,
  });
  const client: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer: owner.pubkey,
    profile: { name: "", picture: "" },
    selected: null,
    memberships: [{ id: joined, name: "Joined" }],
  };
  try {
    render(
      <UnifiedInventory
        state={{ ...control.snapshot(), status: "ready", data: f.data }}
        control={control}
        connection={{
          status: "ready",
          viewer: owner.pubkey,
          scope: `wss://relay.example.test:${owner.pubkey}`,
          generation: 1,
          session: owned.session,
        }}
        client={client}
        edit={() => {}}
        importedId={null}
        onUseHere={() => {}}
        onImport={() => {}}
      />,
    );
    await screen.findByText(/could not be checked for https:\/\/joined/);
    unavailable = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
    const card = await screen.findByRole("article", {
      name: "Agent Native scout",
    });
    expect(card).toBeVisible();
    // The source community's picture uses the native media adapter, not the broker.
    const image = card.querySelector("img");
    expect(image?.getAttribute("src")).toMatch(/^buzz-media:\/\/localhost\//);
    expect(
      decodeURIComponent(image?.getAttribute("src")?.split("/").pop() ?? ""),
    ).toMatch(new RegExp(`^${joined}/media/[0-9a-f]{64}`));
    await waitFor(() =>
      expect(screen.queryByText(/could not be checked/)).toBeNull(),
    );
    // Scoped reads only: no relay info, session or other community request.
    expect(
      requests.every(
        ({ community, path }) => community === joined && path === "/query",
      ),
    ).toBe(true);
    expect(requests.map(({ body }) => body)).toEqual([
      [{ kinds: [30175, 30177], authors: [owner.pubkey], limit: 200 }],
      [{ kinds: [30175, 30177], authors: [owner.pubkey], limit: 200 }],
      [{ kinds: [0], authors: [agent.pubkey], limit: 500 }],
    ]);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    owned.dispose();
    control.dispose();
  }
});
