// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityDialog } from "./CommunityDialog";
import { Context } from "@deepseek-ai/cordis";
import { createCommunities, type Communities } from "./service";

const api = vi.hoisted(() => ({
  inspectProfile: vi.fn<typeof import("./api").inspectProfile>(),
  publishProfile: vi.fn<typeof import("./api").publishProfile>(),
}));
api.inspectProfile.mockRejectedValue(new Error("not admitted"));
api.publishProfile.mockResolvedValue();
vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  inspectProfile: api.inspectProfile,
  publishProfile: api.publishProfile,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("publishes a description-only edit to an existing community profile", async () => {
  api.inspectProfile
    .mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", about: "Before" },
      profile: { name: "Fixture", picture: "", about: "Before" },
    })
    .mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", about: "After" },
      profile: { name: "Fixture", picture: "", about: "After" },
    });
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info") return Response.json({ name: "Fixture" });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "Local", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  await user.type(screen.getByLabelText("Relay URL"), "wss://relay.example");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  const description = await screen.findByLabelText(
    "Profile description (optional)",
  );
  await user.clear(description);
  await user.type(description, "After");
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  expect(api.publishProfile).toHaveBeenCalledWith(
    "https://relay.example",
    { name: "Fixture", picture: "", about: "After" },
    { name: "Fixture", about: "Before" },
  );
  await waitFor(() => expect(communities.joined).toHaveBeenCalledOnce());
});

it("opens with an unchanged over-limit profile and blocks publishing it", async () => {
  const about = "a".repeat(800);
  api.inspectProfile.mockResolvedValueOnce({
    exists: true,
    existing: { name: "Fixture", about },
    profile: { name: "Fixture", picture: "", about },
  });
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info") return Response.json({ name: "Fixture" });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "Local", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  await user.type(screen.getByLabelText("Relay URL"), "wss://relay.example");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  const name = await screen.findByLabelText("Display name");
  await user.type(name, " Renamed");
  expect(
    screen.getByRole("button", { name: "Publish profile & open" }),
  ).toBeDisabled();
  await user.clear(name);
  await user.type(name, "Fixture");
  await user.click(screen.getByRole("button", { name: "Open community" }));
  expect(api.publishProfile).not.toHaveBeenCalled();
  expect(communities.joined).toHaveBeenCalledWith(
    expect.objectContaining({ id: "https://relay.example" }),
    { name: "Fixture", picture: "", about },
  );
});

it("names exact relay claim refusals and keeps other failures generic", async () => {
  const user = userEvent.setup();
  let refusal = "invite_exhausted";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info") return Response.json({ name: "Fixture" });
      if (route === "claim")
        return Response.json({ error: refusal }, { status: 403 });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  await user.type(screen.getByLabelText("Relay URL"), "wss://relay.example");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(
    await screen.findByLabelText("Invite code (if required)"),
    "v2.abc",
  );
  for (const [code, shown] of [
    [
      "invite_exhausted",
      "This invite has no uses left. Ask a community admin for a new one.",
    ],
    [
      "invite_expired",
      "This invite has expired. Ask a community admin for a new one.",
    ],
    ["invite_invalid", "This invite code is not valid for this community."],
    ["Relay request failed (403)", "Relay request failed (403)"],
  ] as const) {
    refusal = code;
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(shown);
  }
});

it.each([
  "https://relay.example/media/avatar.png",
  "https://RELAY.example:443/media/avatar.png",
])(
  "keeps %s out of first-join local defaults without changing the published profile",
  async (picture) => {
    api.inspectProfile.mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture" },
      profile: {
        name: "Fixture",
        picture,
        about: "",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = String(url).split("/").at(-1);
        if (route === "register") return Response.json({ id: "x" });
        if (route === "info") return Response.json({ name: "Fixture" });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "", picture: "" },
      }),
      joined: vi.fn(),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Relay URL"), "wss://relay.example");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      await screen.findByRole("button", { name: "Open community" }),
    );
    expect(api.publishProfile).not.toHaveBeenCalled();
    expect(communities.joined).toHaveBeenCalledWith(
      expect.objectContaining({ id: "https://relay.example" }),
      { name: "Fixture", picture: "", about: "" },
    );
  },
);

it("explains an inherited invalid avatar when editing at join and recovers on replacement", async () => {
  const picture = "http://images.example/avatar.png";
  api.inspectProfile
    .mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", picture },
      profile: { name: "Fixture", picture, about: "" },
    })
    .mockResolvedValueOnce({
      exists: true,
      existing: {},
      profile: {
        name: "Fixture changed",
        picture: "https://images.example/new.png",
        about: "",
      },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/register")) return Response.json({ id: "x" });
      if (url.endsWith("/info")) return Response.json({ name: "Fixture" });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Relay URL"), "wss://relay.example");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText("Display name"), " changed");
  expect(
    screen.getByRole("button", { name: "Publish profile & open" }),
  ).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Use an HTTPS image URL");
  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  const input = await screen.findByLabelText("Picture URL (optional)");
  expect(input).toHaveAccessibleDescription(/Use an HTTPS image URL/);
  await user.clear(input);
  await user.type(input, "https://images.example/new.png");
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  expect(api.publishProfile).toHaveBeenCalledWith(
    "https://relay.example",
    {
      name: "Fixture changed",
      picture: "https://images.example/new.png",
      about: "",
    },
    { name: "Fixture", picture },
  );
  await waitFor(() => expect(communities.joined).toHaveBeenCalledOnce());
});

it("keeps join unavailable after native identity hydration, but still saves a local profile", async () => {
  const ctx = new Context();
  vi.stubGlobal("fetch", vi.fn());
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve("d".repeat(64)),
  );
  try {
    await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
    const view = render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
      />,
    );
    expect(
      screen.getByText(/connecting to communities is not available/),
    ).toBeVisible();
    expect(screen.queryByLabelText("Relay URL")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    const form = screen.getByRole("dialog").querySelector("form");
    if (!form) throw new Error("Join dialog form is missing");
    fireEvent.submit(form);
    expect(fetch).not.toHaveBeenCalled();
    expect(api.inspectProfile).not.toHaveBeenCalled();
    view.unmount();
    const close = vi.fn();
    const user = userEvent.setup();
    render(
      <CommunityDialog
        communities={communities}
        mode="profile"
        close={close}
      />,
    );
    await user.type(screen.getByLabelText("Display name"), "Local only");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(communities.snapshot().profile.name).toBe("Local only");
    expect(fetch).not.toHaveBeenCalled();
    expect(api.publishProfile).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await ctx.fiber.dispose();
    localStorage.clear();
  }
});
