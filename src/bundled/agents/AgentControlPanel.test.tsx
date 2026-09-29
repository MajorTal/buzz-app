// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import * as communityApi from "../../features/communities/api";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { AgentControlPanel } from "./AgentControlPanel";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});

// Exercise the control panel callbacks before the replacement inventory mounts.
function setup(
  _mode: string,
  configure: (f: ReturnType<typeof controlFixture>) => void,
) {
  const f = controlFixture();
  configure(f);
  const control = createAgentControl(f.host);
  disposals.push(() => control.dispose());
  render(
    <AgentControlPanel
      control={control}
      importDestination="https://relay.example.test"
      createOwner={"de".repeat(32)}
    >
      {(state, _edit, _duplicate, _remove, _importedId, _label, onUseHere) =>
        state.status === "ready" && (
          <>
            <article aria-label="Agent Fixture agent">
              <button type="button" onClick={() => onUseHere("ab".repeat(32))}>
                Use here
              </button>
            </article>
          </>
        )
      }
    </AgentControlPanel>,
  );
  return { f };
}

it("dialog actions choose the destination record when several local setups share a key", async () => {
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (_destination, route) =>
      route === "agent-inventory"
        ? { identities: [] }
        : {
            pubkey: "ab".repeat(32),
            relayUrl: "wss://relay.example.test",
            owner: "de".repeat(32),
            signature: "fixture",
          },
    );
  const { f } = setup("connected", (fixture) => {
    fixture.data.parked = [];
    fixture.agent.configured = false;
    fixture.agent.enabled = false;
    fixture.agent.status = "stopped";
    fixture.data.agents.unshift({
      ...structuredClone(fixture.agent),
      id: "first-other-community",
      relayUrl: "wss://elsewhere.example",
      name: "Other saved name",
      systemPrompt: "Other instructions",
    });
  });
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  fireEvent.click(within(card).getByRole("button", { name: "Use here" }));
  const setupDialog = await screen.findByRole("dialog", {
    name: "Set up agent here",
  });
  fireEvent.click(
    within(setupDialog).getByRole("button", { name: "Use here" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Set up agent here" }),
    ).toBeNull(),
  );
  expect(
    f.calls.find((call) => call.action === "configure")?.payload,
  ).toMatchObject({ id: "fixture-agent" });
  expect(request).toHaveBeenCalledWith(
    "https://relay.example.test",
    "resolve-agent-community",
    { pubkey: f.agent.pubkey, owner: "de".repeat(32), confirmed: true },
  );
  expect(
    f.data.agents.find((agent) => agent.id === "first-other-community")
      ?.configured,
  ).toBe(false);
  expect(f.agent.enabled).toBe(false);
});
