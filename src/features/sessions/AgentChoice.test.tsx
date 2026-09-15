// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentLibrary } from "../agents/library";
import type { RelaySession } from "../relay/session";
import { AgentChoice } from "./AgentChoice";

afterEach(cleanup);

it("reloads the selected agent after the connection clears the library", async () => {
  const pubkey = "a".repeat(64);
  const read = vi.fn(async () => ({
    definitions: [],
    identities: [{ pubkey, name: "Selected agent" }],
  }));
  const library = createAgentLibrary(read);
  const session = { agentLibrary: library.queries } as RelaySession;
  const view = render(
    <StrictMode>
      <AgentChoice session={session} value={pubkey} onChange={vi.fn()} />
    </StrictMode>,
  );
  await screen.findByRole("button", { name: "Change agent: Selected agent" });
  await act(async () => library.clear());
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", { name: "Change agent: Selected agent" });
  view.unmount();
  library.dispose();
});

it("opens the avatar menu and changes the chosen agent without submitting", async () => {
  const user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey, name: "Fizz" }],
  }));
  const onChange = vi.fn(),
    onSubmit = vi.fn();
  render(
    <form onSubmit={onSubmit}>
      <AgentChoice
        session={{ agentLibrary: library.queries } as RelaySession}
        value=""
        onChange={onChange}
      />
    </form>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Choose an agent" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Fizz" }));
  expect(onChange).toHaveBeenCalledWith(pubkey, expect.anything());
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  library.dispose();
});
