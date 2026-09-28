// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { npubEncode } from "nostr-tools/nip19";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { PresenceStatus } from "../../features/presence/presence";
import { AgentCard } from "./AgentCard";

afterEach(cleanup);

it("badges a single agent only while live presence is known", () => {
  const pubkey = "a".repeat(64);
  let status: PresenceStatus = "unknown";
  let changed = () => {};
  const session = {
    presence: {
      status: () => status,
      limited: () => false,
      subscribe: (_key: string, listener: () => void) => {
        changed = listener;
        return () => {};
      },
    },
  } as unknown as RelaySession;
  render(
    <AgentCard
      name="Agent"
      avatar="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5qV8AAAAASUVORK5CYII="
      identities={[{ pubkey, name: "Agent" }]}
      session={session}
    />,
  );
  const artwork = screen.getByRole("img", { name: "Agent" });
  expect(artwork).toHaveAttribute("data-avatar-shape", "squircle");
  const image = artwork.querySelector("img");
  expect(image).toBeTruthy();
  fireEvent.load(image as HTMLImageElement);
  expect(image).toHaveAttribute("data-loaded", "true");
  expect(artwork.closest(".buzz-avatar-status")).not.toHaveAttribute(
    "data-status",
  );
  for (const next of ["online", "away", "offline", "unknown"] as const) {
    act(() => {
      status = next;
      changed();
    });
    const updated = screen.getByRole("img", {
      name: next === "unknown" ? "Agent" : `Agent, ${next}`,
    });
    const badge = updated.closest(".buzz-avatar-status");
    expect(updated).toBe(artwork);
    expect(updated.querySelector("img")).toBe(image);
    expect(image).toHaveAttribute("data-loaded", "true");
    if (next === "unknown") {
      expect(badge).not.toHaveAttribute("data-status");
      expect(badge?.querySelector(".buzz-avatar-status-dot")).toBeNull();
    } else {
      expect(badge).toHaveAttribute("data-status", next);
    }
  }
});

it("presents compatibility identities as npubs, not hex", () => {
  const pubkey = "ab".repeat(32);
  render(<AgentCard name="Agent" identities={[{ pubkey, name: "Agent" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Agent:1 identity" }));
  expect(screen.getByText(npubEncode(pubkey))).toBeVisible();
  expect(document.body.textContent).not.toContain(pubkey);
});
