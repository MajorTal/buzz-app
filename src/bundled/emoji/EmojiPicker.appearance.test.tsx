// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair } from "../../features/relay/testing";
import { EmojiPicker } from "./EmojiPicker";

const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  document.documentElement.dataset.colorMode = "light";
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  delete document.documentElement.dataset.colorMode;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(["dark", undefined] as const)(
  "preserves the surface theme across the emoji portal: %s",
  async (mode) => {
    const owner = createRelaySession({
      viewer: keypair().pubkey,
      relayAuthor: keypair().pubkey,
      media: (url) => url,
      query: async () => [],
    });
    owners.push(owner);
    render(
      <section data-color-mode={mode}>
        <EmojiPicker
          session={owner.session}
          scope="fixture"
          reaction
          disabled={false}
          insert={() => {}}
        />
      </section>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    const popup = await screen.findByRole("dialog", { name: "Emoji picker" });
    if (mode) {
      expect(popup).toHaveAttribute("data-color-mode", mode);
      expect(popup).toHaveClass(mode);
    } else {
      expect(popup).not.toHaveAttribute("data-color-mode");
      expect(popup).not.toHaveClass("dark");
    }
    await waitFor(() =>
      expect(popup.querySelector("em-emoji-picker")).toHaveAttribute(
        "theme",
        mode ?? "light",
      ),
    );
  },
);
