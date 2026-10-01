// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { npubEncode } from "nostr-tools/nip19";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair, profile, roster, signed } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import type { AgentLibrary } from "../../features/agents/library";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { profileTarget } from "../../features/profiles/target";
import { ChannelMembersButton } from "./ChannelMembersDialog";
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
});
async function setup(
  type = "stream",
  missingNames = false,
  localAgent = false,
  navigation?: {
    canOpenLink(target: string): boolean;
    onOpenLink(target: string, returnFocus?: HTMLElement): boolean;
  },
) {
  const fixture = controlFixture();
  fixture.agent.status = "stopped";
  const control = createAgentControl(fixture.host);
  await control.refresh();
  stops.push(control.dispose);
  const viewer = keypair(),
    relay = keypair(),
    person = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const target = localAgent ? fixture.agent.pubkey : person.pubkey;
  const members = [viewer.pubkey];
  let clock = 1700000000;
  let failure = "";
  let applyAddition = true;
  let searchFailure = false;
  let nameRetry: Promise<void> | undefined;
  let rosterRead: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const publish = vi.fn(async (_event: RelayEvent) => {
    if (failure) throw new PublishRejected(failure);
    if (release)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (applyAddition) members.push(target);
    clock++;
  });
  const query = vi.fn(async (filters: Parameters<typeof matchesEvent>[1][]) => {
    if (filters.some((filter) => filter.search)) {
      if (searchFailure) throw new Error("Search offline");
      return [profile(person, { name: "Morgan" })];
    }
    if (
      missingNames &&
      filters.some(
        (filter) =>
          filter.kinds?.includes(0) && filter.authors?.includes(viewer.pubkey),
      )
    ) {
      await nameRetry;
      throw new Error("Names unavailable");
    }
    if (filters.some((filter) => filter.kinds?.includes(39002)))
      await rosterRead;
    return [
      roster(relay, id, members, clock),
      signed(relay, {
        kind: 39000,
        content: "",
        tags: [["d", id], ["t", type], ["private"], ["name", "Design"]],
      }),
      signed(relay, { kind: 13535, content: "", tags: [["-"]] }),
      profile(viewer, { name: "Carl" }),
      profile(person, { name: "Morgan" }),
    ].filter((event) => filters.some((filter) => matchesEvent(event, filter)));
  });
  const readAgentLibrary = vi.fn(
    async (): Promise<AgentLibrary> => ({
      definitions: [],
      identities: [],
    }),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      query,
      readAgentLibrary,
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
      agentChoices: control,
    },
  );
  stops.push(owner.dispose);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  render(
    <ToastProvider>
      <ChannelMembersButton
        session={owner.session}
        channelId={id}
        control={control}
        {...navigation}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Channel members" });
  await user.click(trigger);
  if (missingNames) await screen.findByText(/Some names could not load/);
  else await screen.findByText("Carl (you)");
  return {
    user,
    trigger,
    fixture,
    control,
    dispose: owner.dispose,
    publish,
    query,
    readAgentLibrary,
    session: owner.session,
    person,
    viewer,
    delayRoster: () => {
      applyAddition = false;
    },
    confirmRoster: () => {
      members.push(target);
      clock++;
    },
    removeTarget: () => {
      members.splice(members.indexOf(target), 1);
      clock++;
    },
    fail: (value: string) => {
      failure = value;
    },
    holdRoster: (pending: Promise<void> | undefined) => {
      rosterRead = pending;
    },
    holdNames: (pending: Promise<void>) => {
      nameRetry = pending;
    },
    recoverNames: () => {
      missingNames = false;
    },
    failSearch: (value = true) => {
      searchFailure = value;
    },
    hold: () => {
      release = () => {};
    },
    release: () => release?.(),
    async search() {
      await user.type(
        screen.getByRole("searchbox"),
        localAgent ? "Fixture agent" : "Morgan",
      );
      return screen.findByRole("button", {
        name: localAgent ? /Add Fixture agent/ : /Add Morgan/,
      });
    },
  };
}
it("searches outside the roster, prevents double submission, and moves confirmed additions into Members", async () => {
  const t = await setup();
  const add = await t.search();
  t.hold();
  await t.user.click(add);
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  expect(add).toHaveAttribute("aria-disabled", "true");
  await t.user.click(add);
  expect(t.publish).toHaveBeenCalledOnce();
  await act(async () => t.release());
  await screen.findByText("Morgan is in the channel.");
  expect(
    screen.queryByRole("button", { name: /Add Morgan/ }),
  ).not.toBeInTheDocument();
  expect(t.session.channels.list().channels[0]?.members).toContain(
    t.person.pubkey,
  );
});
it("shows the real rejection and retries without discarding the query", async () => {
  const t = await setup();
  t.fail("Only the owner can add this agent");
  await t.user.click(await t.search());
  await screen.findByText(/Only the owner/);
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
  t.fail("");
  await t.user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Morgan is in the channel.");
});
it("DMs are view-only and never search outside their members", async () => {
  const t = await setup("dm");
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  expect(
    screen.getByText("DM membership cannot be changed here."),
  ).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Not in this channel" }),
  ).not.toBeInTheDocument();
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(
    t.query.mock.calls.some(([filters]) =>
      filters.some((filter) => filter.search),
    ),
  ).toBe(false);
});
it("Escape closes the dialog and restores focus to its header button", async () => {
  const t = await setup();
  expect(screen.getByRole("searchbox")).toHaveFocus();
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Channel members" })).toHaveFocus();
});
it("failed directory searches recover through the shared refresh, not a false empty result", async () => {
  const t = await setup();
  t.failSearch();
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  const section = screen.getByRole("region", { name: "Not in this channel" });
  await within(section).findByText("Search offline");
  expect(
    within(section).queryByText("No other matching people or agents."),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^Retry/ }),
  ).not.toBeInTheDocument();
  t.failSearch(false);
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  await t.user.click(refresh);
  await within(section).findByRole("button", { name: /Add Morgan/ });
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
  expect(within(section).queryByText("Search offline")).not.toBeInTheDocument();
});

it("finds an existing member by their canonical public key", async () => {
  const t = await setup("dm");
  await t.user.type(screen.getByRole("searchbox"), npubEncode(t.viewer.pubkey));
  expect(screen.getByText("Carl (you)")).toBeVisible();
});

it("optional member-name failure does not block a verified addition", async () => {
  const t = await setup("stream", true);
  const add = await t.search();
  expect(add).toBeEnabled();
  await t.user.click(add);
  await screen.findByText("Morgan is in the channel.");
  expect(t.publish).toHaveBeenCalledOnce();
});

it.each(["pending", "failed"])(
  "shared refresh retries missing names without blocking verified additions while names are %s",
  async (state) => {
    const t = await setup("stream", true);
    await t.search();
    const refresh = screen.getByRole("button", { name: "Refresh member data" });
    await vi.waitFor(() =>
      expect(refresh).toHaveAttribute("aria-busy", "false"),
    );
    const nameReads = () =>
      t.query.mock.calls.filter(([filters]) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(0) &&
            filter.authors?.includes(t.viewer.pubkey),
        ),
      ).length;
    const beforeNames = nameReads();
    let release!: () => void;
    t.holdNames(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      await t.user.click(refresh);
      await vi.waitFor(() => expect(nameReads()).toBe(beforeNames + 1));
      const add = await screen.findByRole("button", { name: /Add Morgan/ });
      await vi.waitFor(() => expect(add).toBeEnabled());
      expect(refresh).toHaveAttribute("aria-busy", "true");
      expect(refresh).toHaveAttribute("aria-disabled", "true");
      if (state === "failed") {
        await act(async () => release());
        await screen.findByText(/Some names could not load/);
        await vi.waitFor(() =>
          expect(refresh).toHaveAttribute("aria-busy", "false"),
        );
        expect(add).toBeEnabled();
      }
      await t.user.click(add);
      await screen.findByText("Morgan is in the channel.");
      expect(t.publish).toHaveBeenCalledOnce();
    } finally {
      await act(async () => release());
    }
  },
);

it("one refresh retries every failed data source and never replays a failed invitation", async () => {
  const t = await setup("stream", true);
  t.fail("Invitation denied");
  await t.user.click(await t.search());
  await screen.findByText(/Invitation denied/);
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockRejectedValue(new Error("Reads offline"));
  t.readAgentLibrary.mockRejectedValueOnce(new Error("Agents offline"));
  await t.user.click(refresh);
  await screen.findByText(/The member list could not load/);
  await screen.findByText(/Some agents could not load/);
  await screen.findByText(/Archived identities could not be checked/);
  await within(
    screen.getByRole("region", { name: "Not in this channel" }),
  ).findByText("Reads offline");
  await screen.findByText(/Some names could not load/);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  // The sole remaining Retry is the explicit invitation intent, not a fetch.
  expect(screen.getAllByRole("button", { name: /^Retry/ })).toHaveLength(1);
  t.query.mockImplementation(query);
  t.query.mockClear();
  t.readAgentLibrary.mockClear();
  t.recoverNames();
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  const filters = t.query.mock.calls.flatMap(([filters]) => filters);
  expect(filters.some((filter) => filter.kinds?.includes(39002))).toBe(true);
  expect(filters.some((filter) => filter.kinds?.includes(39001))).toBe(true);
  expect(filters.some((filter) => filter.kinds?.includes(13535))).toBe(true);
  expect(
    filters.some((filter) => filter.authors?.includes(t.viewer.pubkey)),
  ).toBe(true);
  expect(filters.some((filter) => filter.search === "Morgan")).toBe(true);
  expect(t.readAgentLibrary).toHaveBeenCalledOnce();
  expect(t.session.archives.snapshot().status).toBe("ready");
  expect(t.session.profiles.snapshot().get(t.viewer.pubkey)?.name).toBe("Carl");
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
  expect(
    screen.queryByText(
      /The member list could not load|Some agents could not load|Archived identities could not be checked|Some names could not load/,
    ),
  ).not.toBeInTheDocument();
  expect(t.publish).toHaveBeenCalledOnce();
  expect(screen.getByText(/Invitation denied/)).toBeVisible();
});

it.each(["search", "archives", "agents", "native agents"])(
  "keeps the shared refresh busy until %s settle, then permits recovery",
  async (source) => {
    const t = await setup();
    await t.search();
    const refresh = screen.getByRole("button", { name: "Refresh member data" });
    await vi.waitFor(() =>
      expect(refresh).toHaveAttribute("aria-busy", "false"),
    );
    const query = t.query.getMockImplementation();
    if (!query) throw new Error("Missing query fixture");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const hold = async () => {
      started++;
      await gate;
      throw new Error("Held read failed");
    };
    if (source === "agents") t.readAgentLibrary.mockImplementationOnce(hold);
    else if (source === "native agents")
      vi.spyOn(t.fixture.host, "snapshot").mockImplementationOnce(hold);
    else
      t.query.mockImplementation(async (filters) => {
        if (
          filters.some((filter) =>
            source === "search"
              ? !!filter.search
              : filter.kinds?.includes(13535),
          )
        )
          await hold();
        return query(filters);
      });
    try {
      await t.user.click(refresh);
      await vi.waitFor(() => expect(started).toBe(1));
      await vi.waitFor(() =>
        expect(
          t.session.memberAdministration.snapshot(
            "11111111-1111-4111-8111-111111111111",
          ).status,
        ).toBe("error"),
      );
      expect(refresh).toHaveAttribute("aria-busy", "true");
      expect(refresh).toHaveAttribute("aria-disabled", "true");
      await t.user.click(refresh);
    } finally {
      await act(async () => release());
    }
    await vi.waitFor(() =>
      expect(refresh).toHaveAttribute("aria-busy", "false"),
    );
    expect(started).toBe(1);
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("refresh restarts the current directory query from page one instead of mixing stale pages", async () => {
  const t = await setup();
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  const pageOne = Array.from({ length: 30 }, (_, index) =>
    profile(keypair(), { name: `Morgan ${index}` }),
  );
  const pageTwo = profile(keypair(), { name: "Morgan stale" });
  let fresh = false;
  t.query.mockImplementation(async (filters) => {
    const search = filters.find((filter) => filter.search);
    return search
      ? fresh
        ? pageOne.slice(0, 1)
        : search.page === 2
          ? [pageTwo]
          : pageOne
      : query(filters);
  });
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  const more = await screen.findByRole("button", { name: "Show more results" });
  expect(more).toHaveAttribute("data-size", "sm");
  expect(more.parentElement).toHaveClass("flex", "justify-center");
  await t.user.click(more);
  await screen.findByText("Morgan stale");
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  fresh = true;
  t.query.mockClear();
  await t.user.click(refresh);
  await screen.findByText("Morgan 0");
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(screen.queryByText("Morgan stale")).not.toBeInTheDocument();
  expect(
    t.query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.search)
      .map((filter) => filter.page),
  ).toEqual([1]);
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
});

it("finishes confirmed local-agent startup after closing and reopening during publication", async () => {
  const t = await setup("stream", false, true);
  t.hold();
  await t.user.click(await t.search());
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await t.user.click(screen.getByRole("button", { name: "Channel members" }));
  await t.search();
  expect(screen.getByText("Adding…")).toBeVisible();
  await act(async () => t.release());
  await vi.waitFor(() =>
    expect(t.control.snapshot().data?.agents[0]?.status).toBe("running"),
  );
  expect(t.publish).toHaveBeenCalledOnce();
  expect(
    t.fixture.calls.filter((call) => call.action === "start"),
  ).toHaveLength(1);
});

it("keeps closed-dialog startup failures recoverable without another membership write", async () => {
  const t = await setup("stream", false, true);
  const action = t.fixture.host.action;
  vi.spyOn(t.fixture.host, "action")
    .mockRejectedValueOnce(new Error("Missing credentials"))
    .mockImplementation(action);
  t.hold();
  await t.user.click(await t.search());
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await act(async () => t.release());
  await vi.waitFor(() =>
    expect(t.session.memberAdditions.snapshot()[0]?.error).toContain(
      "agent did not start",
    ),
  );
  await t.user.click(screen.getByRole("button", { name: "Channel members" }));
  await screen.findByText(/Added to the channel, but the agent did not start/);
  await t.user.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(t.control.snapshot().data?.agents[0]?.status).toBe("running"),
  );
  expect(t.publish).toHaveBeenCalledOnce();
  expect(t.session.memberAdditions.snapshot()).toEqual([]);
});

it("does not start the agent after its relay session is disposed", async () => {
  const t = await setup("stream", false, true);
  t.hold();
  await t.user.click(await t.search());
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  cleanup();
  await act(async () => t.dispose());
  await act(async () => t.release());
  expect(t.fixture.calls.some((call) => call.action === "start")).toBe(false);
});

it.each(["none", "rejected", "lagging"])(
  "requires explicit re-add after remote removal, preserving retry identity (%s)",
  async (failure) => {
    const rejectReadd = failure === "rejected";
    const t = await setup("stream", false, true);
    const action = vi
      .spyOn(t.fixture.host, "action")
      .mockRejectedValueOnce(new Error("Missing credentials"));
    await t.user.click(await t.search());
    await screen.findByText(/agent did not start/);
    await t.user.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await t.user.click(screen.getByRole("button", { name: "Channel members" }));
    await screen.findByText(/agent did not start/);
    await vi.waitFor(() =>
      expect(screen.queryByText("Loading members…")).not.toBeInTheDocument(),
    );
    // Change relay evidence only: the cached roster still contains this agent.
    t.removeTarget();
    expect(t.session.channels.list().channels[0]?.members).toContain(
      t.fixture.agent.pubkey,
    );
    await t.user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Membership changed/);
    expect(action).toHaveBeenCalledOnce();
    expect(t.publish).toHaveBeenCalledOnce();
    expect(t.session.channels.list().channels[0]?.members).not.toContain(
      t.fixture.agent.pubkey,
    );
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    if (rejectReadd) t.fail("Addition denied");
    if (failure === "lagging") t.delayRoster();
    await t.user.click(await t.search());
    if (rejectReadd) {
      await screen.findByText(/Addition denied/);
      t.fail("");
      await t.user.click(screen.getByRole("button", { name: "Retry" }));
    }
    if (failure === "lagging") {
      await screen.findByText(/Addition is not confirmed/);
      await t.user.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText(/Addition is not confirmed/);
      expect(t.publish).toHaveBeenCalledTimes(2);
      t.confirmRoster();
      await t.user.click(screen.getByRole("button", { name: "Retry" }));
    }
    await vi.waitFor(() =>
      expect(t.control.snapshot().data?.agents[0]?.status).toBe("running"),
    );
    expect(t.publish).toHaveBeenCalledTimes(rejectReadd ? 3 : 2);
    const ids = t.publish.mock.calls.map(([event]) => event.id);
    expect(ids[0]).not.toBe(ids[1]);
    if (rejectReadd) expect(ids[1]).toBe(ids[2]);
    expect(action).toHaveBeenCalledTimes(2);
  },
);

it("keeps known members quiet while rechecking membership without enabling unverified additions", async () => {
  const t = await setup();
  await vi.waitFor(() =>
    expect(screen.queryByText("Loading members…")).toBeNull(),
  );
  expect(await t.search()).toBeEnabled();
  await t.user.keyboard("{Escape}");
  // Roster availability and role verification are independent reads: missing
  // role metadata must not block ordinary invitations or hide cached members.
  const rosterReads = () =>
    t.query.mock.calls.filter(
      ([filters]) =>
        filters.length === 1 &&
        filters[0]?.kinds?.length === 1 &&
        filters[0].kinds[0] === 39002,
    ).length;
  const authorityReads = () =>
    t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(39001)),
    ).length;
  const beforeAuthority = authorityReads();
  const before = rosterReads();
  let release!: () => void;
  t.holdRoster(
    new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error("Roster unavailable"));
    }),
  );
  try {
    await t.user.click(screen.getByRole("button", { name: "Channel members" }));
    await vi.waitFor(() => expect(rosterReads()).toBe(before + 1));
    expect(authorityReads()).toBe(beforeAuthority + 1);
    expect(screen.getByText("Carl (you)")).toBeVisible();
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    const add = await t.search();
    expect(add).toBeDisabled();
    // No matching members is not an empty roster.
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    await act(async () => release());
    const retry = await screen.findByRole("button", {
      name: "Refresh member data",
    });
    expect(add).toBeDisabled();
    await vi.waitFor(() => expect(retry).toHaveAttribute("aria-busy", "false"));
    t.holdRoster(undefined);
    await t.user.click(retry);
    // Shared refresh replaces directory results; assert on the current control,
    // not the detached Add button from the failed read.
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /Add Morgan/ })).toBeEnabled(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  } finally {
    await act(async () => release());
  }
});

beforeEach(() => {
  // jsdom hides [popover] but has no native top layer. Browser tests own paint.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});

it.each(["avatar", "row", "keyboard"])(
  "opens the exact member profile from the %s and supplies the stable header return target",
  async (activation) => {
    const onOpenLink = vi.fn(() => true);
    const t = await setup("stream", false, false, {
      canOpenLink: () => true,
      onOpenLink,
    });
    const row = screen.getByRole("button", { name: /Open profile for Carl/ });
    if (activation === "keyboard") {
      row.focus();
      await t.user.keyboard("{Enter}");
    } else if (activation === "avatar") {
      const avatar = row.parentElement?.parentElement?.querySelector(
        "[data-avatar-shape]",
      );
      if (!avatar) throw new Error("Missing member avatar");
      await t.user.click(avatar);
    } else await t.user.click(row);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
      profileTarget(t.viewer.pubkey),
      screen.getByRole("button", { name: "Channel members" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("keeps Members open when the profile dispatcher declines the target", async () => {
  const onOpenLink = vi.fn(() => false);
  const t = await setup("stream", false, false, {
    canOpenLink: () => true,
    onOpenLink,
  });
  await t.user.click(
    screen.getByRole("button", { name: /Open profile for Carl/ }),
  );
  expect(onOpenLink).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Channel members" })).toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: /identity$/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Open profile for Carl/ }),
  ).toHaveFocus();
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Channel members" })).toHaveFocus();
  expect(t.publish).not.toHaveBeenCalled();
});

it("does not offer profile controls without an available Profiles contribution", async () => {
  const onOpenLink = vi.fn(() => true);
  const t = await setup("stream", false, false, {
    canOpenLink: () => false,
    onOpenLink,
  });
  expect(
    screen.queryByRole("button", { name: /Open profile for/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Carl (you)")).toBeVisible();
  expect(onOpenLink).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("refreshes membership even when verified role metadata is unavailable", async () => {
  const t = await setup();
  const refresh = screen.getByRole("button", {
    name: "Refresh member data",
  });
  await vi.waitFor(() =>
    expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
  );
  t.confirmRoster();
  await t.user.click(refresh);
  await screen.findByText("Morgan");
  await vi.waitFor(() =>
    expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
  );
  expect(screen.getByRole("region", { name: "Members" })).toHaveTextContent(
    "Members · 2",
  );
  expect(
    t.session.memberAdministration.snapshot(
      "11111111-1111-4111-8111-111111111111",
    ).status,
  ).toBe("error");
  expect(t.publish).not.toHaveBeenCalled();
});

it("shares the identity presentation with invitation rows without assigning a channel role", async () => {
  const t = await setup("stream", false, true);
  const add = await t.search();
  const row = screen.getByRole("region", { name: "Not in this channel" });
  expect(within(row).getByText("Fixture agent", { exact: true })).toBeVisible();
  expect(
    within(row).queryByText("Agent", { exact: true }),
  ).not.toBeInTheDocument();
  expect(within(row).queryByText("managed by")).not.toBeInTheDocument();
  expect(
    row.querySelector('[data-avatar-shape="squircle"]'),
  ).toBeInTheDocument();
  const key = row.querySelector('[aria-hidden="true"].text-mono');
  expect(key).toHaveTextContent(/^npub/);
  const npub = npubEncode(t.fixture.agent.pubkey);
  expect(key).toHaveTextContent(`${npub.slice(0, 11)}…${npub.slice(-6)}`);
  expect(
    within(row).queryByRole("button", { name: /Copy/ }),
  ).not.toBeInTheDocument();
  expect(
    within(row).queryByRole("button", { name: "Actions for Fixture agent" }),
  ).not.toBeInTheDocument();
  add.focus();
  await t.user.keyboard("{Shift>}{F10}{/Shift}");
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["View profile"]);
  await t.user.keyboard("{Escape}");
  expect(row.querySelector("[title]")).not.toBeInTheDocument();
  expect(within(row).queryByText("Role unverified")).not.toBeInTheDocument();
  expect(within(add).getByText("Add", { exact: true })).toBeVisible();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each(["avatar", "row", "keyboard"])(
  "opens a non-member profile from the %s without inviting them",
  async (activation) => {
    const onOpenLink = vi.fn(() => true);
    const t = await setup("stream", false, false, {
      canOpenLink: () => true,
      onOpenLink,
    });
    const add = await t.search();
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    expect(row).not.toContainElement(add);
    expect(add).not.toContainElement(row);
    if (activation === "keyboard") {
      row.focus();
      await t.user.keyboard("{Enter}");
    } else if (activation === "avatar") {
      const avatar = row.parentElement?.parentElement?.querySelector(
        "[data-avatar-shape]",
      );
      if (!avatar) throw new Error("Missing invitation avatar");
      await t.user.click(avatar);
    } else await t.user.click(row);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
      profileTarget(t.person.pubkey),
      screen.getByRole("button", { name: "Channel members" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("invites only through the separate prominent Add button and leaves profile navigation available while pending", async () => {
  const onOpenLink = vi.fn(() => true);
  const t = await setup("stream", false, false, {
    canOpenLink: () => true,
    onOpenLink,
  });
  const add = await t.search();
  expect(add).toHaveAttribute("data-variant", "prominent");
  expect(add).toHaveAttribute("data-size", "xs");
  t.hold();
  try {
    await t.user.click(add);
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    expect(onOpenLink).not.toHaveBeenCalled();
    expect(add).toHaveTextContent("Adding…");
    await t.user.click(add);
    expect(t.publish).toHaveBeenCalledOnce();
    await t.user.click(
      screen.getByRole("button", { name: /Open profile for Morgan/ }),
    );
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
      profileTarget(t.person.pubkey),
      screen.getByRole("button", { name: "Channel members" }),
    );
  } finally {
    await act(async () => t.release());
  }
});

it("keeps Add separate and usable when non-member profile navigation is declined or unavailable", async () => {
  const onOpenLink = vi.fn(() => false);
  let supported = true;
  const t = await setup("stream", false, false, {
    canOpenLink: () => supported,
    onOpenLink,
  });
  await t.search();
  await t.user.click(
    screen.getByRole("button", { name: /Open profile for Morgan/ }),
  );
  expect(screen.getByRole("dialog", { name: "Channel members" })).toBeVisible();
  expect(t.publish).not.toHaveBeenCalled();
  supported = false;
  await t.user.clear(screen.getByRole("searchbox"));
  await t.search();
  expect(
    screen.queryByRole("button", { name: /Open profile for Morgan/ }),
  ).not.toBeInTheDocument();
  await t.user.click(screen.getByRole("button", { name: /Add Morgan/ }));
  await screen.findByText("Morgan is in the channel.");
  expect(t.publish).toHaveBeenCalledOnce();
  expect(onOpenLink).toHaveBeenCalledOnce();
});

function managedProfile(
  agent: ReturnType<typeof keypair>,
  manager: ReturnType<typeof keypair>,
  time: number,
  valid = true,
) {
  const digest = new Uint8Array(
    createHash("sha256").update(`nostr:agent-auth:${agent.pubkey}:`).digest(),
  );
  return signed(agent, {
    kind: 0,
    created_at: time,
    content: JSON.stringify({ name: "Morgan", is_agent: true }),
    tags: [
      [
        "auth",
        manager.pubkey,
        "",
        bytesToHex(schnorr.sign(digest, (valid ? manager : agent).secret)),
      ],
    ],
  });
}

it.each([
  [false, "hint"],
  [true, "hint"],
  [false, "menu"],
  [true, "menu"],
] as const)(
  "opens the verified manager without inviting or opening the agent (member: %s, source: %s)",
  async (member, source) => {
    const onOpenLink = vi.fn(() => true);
    const t = await setup("stream", false, false, {
      canOpenLink: () => true,
      onOpenLink,
    });
    const agent = managedProfile(t.person, t.viewer, 1800000000);
    const original = t.query.getMockImplementation();
    if (!original) throw new Error("Missing query");
    t.query.mockImplementation(async (filters) =>
      (await original(filters)).map((event) =>
        event.pubkey === t.person.pubkey && event.kind === 0 ? agent : event,
      ),
    );
    if (member) {
      t.confirmRoster();
      await vi.waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Refresh member data" }),
        ).toHaveAttribute("aria-busy", "false"),
      );
      await t.user.click(
        screen.getByRole("button", { name: "Refresh member data" }),
      );
    } else await t.search();
    const owner = await screen.findByRole("button", {
      name: "Open owner profile: Carl (you)",
    });
    const profileButton = screen.getByRole("button", {
      name: /Open profile for Morgan/,
    });
    expect(profileButton).not.toContainElement(owner);
    expect(owner.closest("button button")).toBeNull();
    expect(
      screen.queryByText("Agent", { exact: true }),
    ).not.toBeInTheDocument();
    expect(owner.parentElement).toHaveTextContent("managed by Carl (you)");
    if (source === "hint") {
      owner.focus();
      await t.user.keyboard("{Enter}");
    } else {
      if (member) {
        await t.user.click(
          screen.getByRole("button", { name: "Actions for Morgan" }),
        );
      } else {
        expect(
          screen.queryByRole("button", { name: "Actions for Morgan" }),
        ).toBeNull();
        profileButton.focus();
        await t.user.keyboard("{Shift>}{F10}{/Shift}");
      }
      expect(
        (await screen.findAllByRole("menuitem")).map(
          (item) => item.textContent,
        ),
      ).toEqual(["View profile", "View owner profile"]);
      await t.user.click(
        screen.getByRole("menuitem", { name: "View owner profile" }),
      );
    }
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
      profileTarget(t.viewer.pubkey),
      screen.getByRole("button", { name: "Channel members" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each(["unavailable", "declined"] as const)(
  "keeps Members usable when owner profile navigation is %s",
  async (navigation) => {
    const onOpenLink = vi.fn(() => false);
    const t = await setup("stream", false, false, {
      canOpenLink: () => navigation !== "unavailable",
      onOpenLink,
    });
    const agent = managedProfile(t.person, t.viewer, 1800000000);
    const original = t.query.getMockImplementation();
    if (!original) throw new Error("Missing query");
    t.query.mockImplementation(async (filters) =>
      (await original(filters)).map((event) =>
        event.pubkey === t.person.pubkey && event.kind === 0 ? agent : event,
      ),
    );
    await t.search();
    await screen.findByText(/managed by/);
    const actions = screen.getByRole("button", { name: /Add Morgan/ });
    expect(
      screen.queryByRole("button", { name: "Actions for Morgan" }),
    ).toBeNull();
    actions.focus();
    await t.user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu", {
      name: "Actions for Morgan",
    });
    await vi.waitFor(() => expect(menu).toHaveFocus());
    if (navigation === "unavailable") {
      expect(
        screen.queryByRole("menuitem", { name: "View owner profile" }),
      ).toBeNull();
      expect(onOpenLink).not.toHaveBeenCalled();
      await t.user.keyboard("{Escape}");
    } else {
      await t.user.click(
        screen.getByRole("menuitem", { name: "View owner profile" }),
      );
      expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
        profileTarget(t.viewer.pubkey),
        t.trigger,
      );
      await vi.waitFor(() => expect(actions).toHaveFocus());
    }
    expect(
      screen.getByRole("dialog", { name: "Channel members" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Add Morgan/ })).toBeEnabled();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("removes ownership on a newer invalid signed head and never restores it from an older read", async () => {
  const t = await setup("stream", false, false, {
    canOpenLink: () => true,
    onOpenLink: () => true,
  });
  const original = t.query.getMockImplementation();
  if (!original) throw new Error("Missing query");
  let head = managedProfile(t.person, t.viewer, 1800000000);
  const first = head;
  t.query.mockImplementation(async (filters) =>
    (await original(filters)).map((event) =>
      event.pubkey === t.person.pubkey && event.kind === 0 ? head : event,
    ),
  );
  await t.search();
  await screen.findByRole("button", { name: "Open owner profile: Carl (you)" });
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  head = managedProfile(t.person, t.viewer, 1800000001, false);
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(
    screen.queryByText("managed by", { exact: false }),
  ).not.toBeInTheDocument();
  head = first;
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(
    screen.queryByRole("button", { name: /Open owner profile/ }),
  ).not.toBeInTheDocument();
  screen.getByRole("button", { name: /Add Morgan/ }).focus();
  await t.user.keyboard("{Shift>}{F10}{/Shift}");
  await screen.findByRole("menu", { name: "Actions for Morgan" });
  expect(
    screen.queryByRole("menuitem", { name: "View owner profile" }),
  ).toBeNull();

  expect(t.publish).not.toHaveBeenCalled();
});

it("retries ownership admission and failed owner names through the shared refresh", async () => {
  const t = await setup("stream", false, false, {
    canOpenLink: () => true,
    onOpenLink: () => true,
  });
  const manager = keypair();
  const agent = managedProfile(t.person, manager, 1800000000);
  const original = t.query.getMockImplementation();
  if (!original) throw new Error("Missing query");
  let failName = true;
  t.query.mockImplementation(async (filters) => {
    if (filters.some((f) => f.authors?.includes(manager.pubkey))) {
      if (failName) throw new Error("Name unavailable");
      return [profile(manager, { name: "Manager" })];
    }
    return (await original(filters)).map((event) =>
      event.pubkey === t.person.pubkey && event.kind === 0 ? agent : event,
    );
  });
  const held: ReturnType<typeof t.session.observe>[] = [];
  try {
    for (let i = 0; i < 64; i++)
      held.push(
        t.session.observe([
          { kinds: [0], authors: [t.viewer.pubkey], limit: 1 },
        ]),
      );
  } catch {
    /* Fill the actual session view budget. */
  }
  stops.push(() => {
    for (const view of held) view.dispose();
  });
  await t.search();
  await screen.findByText(/Some agent managers or their names could not load/);
  expect(
    screen.queryByRole("button", { name: /Open owner profile/ }),
  ).not.toBeInTheDocument();
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  for (const view of held) view.dispose();
  await t.user.click(refresh);
  await screen.findByRole("button", { name: /Open owner profile: npub/ });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(
    screen.getByText(/Some agent managers or their names could not load/),
  ).toBeVisible();
  failName = false;
  await t.user.click(refresh);
  await screen.findByRole("button", { name: "Open owner profile: Manager" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(
    screen.queryByText(/Some agent managers or their names could not load/),
  ).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

it("pages combined local and relay invitations without losing matches, and resets on query or refresh", async () => {
  const t = await setup();
  const remote = Array.from({ length: 30 }, (_, index) =>
    profile(keypair(), { name: `Helper remote ${index}` }),
  );
  const lastRemote = profile(keypair(), { name: "Helper final" });
  const local = Array.from({ length: 65 }, (_, index) => ({
    pubkey: keypair().pubkey,
    name: `Helper local ${index}`,
  }));
  const firstRemote = remote[0];
  if (!firstRemote) throw new Error("Missing first remote fixture");
  t.readAgentLibrary.mockResolvedValue({
    definitions: [],
    identities: [
      ...local,
      { pubkey: firstRemote.pubkey, name: "Helper remote 0" },
    ],
  });
  await act(async () => {
    await t.session.agentChoices.refresh();
  });
  const query = t.query.getMockImplementation();
  if (!query) throw new Error("Missing query fixture");
  t.query.mockImplementation(async (filters) => {
    const search = filters.find((filter) => filter.search);
    return search
      ? search.page === 2
        ? [lastRemote]
        : remote
      : query(filters);
  });
  const input = screen.getByRole("searchbox");
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  const rows = () =>
    within(
      screen.getByRole("region", { name: "Not in this channel" }),
    ).getAllByRole("button", { name: /^Add / });
  const pages = () =>
    t.query.mock.calls
      .flatMap(([filters]) => filters)
      .filter((filter) => filter.search)
      .map((filter) => filter.page);
  await t.user.type(input, "Helper");
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(rows()).toHaveLength(30);
  expect(
    rows().every((row) =>
      row.getAttribute("aria-label")?.startsWith("Add Helper remote"),
    ),
  ).toBe(true);
  expect(pages()).toEqual([1]);
  for (const count of [60, 90, 95]) {
    await t.user.click(
      screen.getByRole("button", { name: "Show more results" }),
    );
    expect(rows()).toHaveLength(count);
    expect(pages()).toEqual([1]);
  }
  await t.user.click(screen.getByRole("button", { name: "Show more results" }));
  await screen.findByRole("button", { name: /^Add Helper final/ });
  expect(rows()).toHaveLength(96);
  expect(pages()).toEqual([1, 2]);
  expect(
    screen.queryByRole("button", { name: "Show more results" }),
  ).toBeNull();
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(rows()).toHaveLength(30);
  expect(pages()).toEqual([1, 2, 1]);
  await t.user.click(screen.getByRole("button", { name: "Show more results" }));
  expect(rows()).toHaveLength(60);
  await t.user.type(input, " local");
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(rows()).toHaveLength(30);
  await t.user.clear(input);
  expect(
    screen.queryByRole("region", { name: "Not in this channel" }),
  ).toBeNull();
  expect(t.publish).not.toHaveBeenCalled();
});

it("controlled presentation restores the dialog without retaining its search or issuing writes", async () => {
  const t = await setup();
  cleanup();
  const onOpenChange = vi.fn();
  const button = (open: boolean) => (
    <ToastProvider>
      <ChannelMembersButton
        session={t.session}
        channelId="11111111-1111-4111-8111-111111111111"
        presentation={{ open, onOpenChange }}
      />
    </ToastProvider>
  );
  const view = render(button(false));
  await t.user.click(screen.getByRole("button", { name: "Channel members" }));
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(button(true));
  await screen.findByText("Carl (you)");
  await t.user.type(screen.getByRole("searchbox"), "Carl");
  await t.user.keyboard("{Escape}");
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  view.rerender(button(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(button(true));
  await screen.findByText("Carl (you)");
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(t.publish).not.toHaveBeenCalled();
});
