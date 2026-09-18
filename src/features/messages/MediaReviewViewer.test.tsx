// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, message, profile, signed } from "../relay/testing";
import { MediaReviewViewer } from "./MediaReviewViewer";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

it("keeps fullscreen comment avatar hints in sync without loading the agent library", async () => {
  const viewer = keypair(),
    marked = keypair(),
    libraryAgent = keypair(),
    envelope = keypair();
  const attachment = { url: "https://fixture.test/image.png", video: false };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${attachment.url}`, "m image/png"],
  ]);
  const tags = [["e", root.id, "", "reply"]];
  const replies = [
    message(viewer, "one", "Human comment", 2, tags),
    message(marked, "one", "Profile agent comment", 3, tags),
    message(libraryAgent, "one", "Library agent comment", 4, tags),
    signed(envelope, {
      kind: 40002,
      content: JSON.stringify({ content: "Envelope agent comment" }),
      created_at: 5,
      tags: [["h", "one"], ...tags],
    }),
  ];
  let identities = [{ pubkey: libraryAgent.pubkey, name: "Library agent" }];
  const readAgentLibrary = vi.fn(async () => ({ definitions: [], identities }));
  const profiles = [
    profile(viewer, { name: "Human" }),
    profile(marked, { name: "Profile agent", is_agent: true }),
    profile(libraryAgent, { name: "Library agent" }),
    profile(envelope, { name: "Envelope agent" }),
  ];
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    readAgentLibrary,
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(0))
          return profiles.filter((event) =>
            filter.authors?.includes(event.pubkey),
          );
        if (filter.ids)
          return [root, ...replies].filter((event) =>
            filter.ids?.includes(event.id),
          );
        if (filter.depth_limit)
          return replies.filter(
            (event) =>
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor,
          );
        return [];
      });
    },
  });
  owners.push(owner);
  render(
    <StrictMode>
      <MediaReviewViewer
        attachment={attachment}
        session={owner.session}
        scope="avatar-test"
        channelId="one"
        channelName="One"
        messageId={root.id}
        initialTime={0}
        close={() => {}}
      />
    </StrictMode>,
  );
  const avatar = (text: string) =>
    screen
      .getByText(text)
      .closest("[data-message-id]")
      ?.querySelector("[data-avatar-shape]");
  await screen.findByText("Profile agent comment");
  await waitFor(() => {
    expect(avatar("Human comment")).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    expect(avatar("Profile agent comment")).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
    expect(avatar("Library agent comment")).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    expect(avatar("Envelope agent comment")).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
  });
  expect(readAgentLibrary).not.toHaveBeenCalled();
  await act(() => owner.session.agentLibrary.refresh());
  expect(avatar("Library agent comment")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  identities = [];
  await act(() => owner.session.agentLibrary.refresh());
  expect(avatar("Library agent comment")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  expect(avatar("Profile agent comment")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(readAgentLibrary).toHaveBeenCalledTimes(2);
});
