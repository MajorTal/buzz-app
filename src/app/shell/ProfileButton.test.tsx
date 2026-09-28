// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AccountActionsService } from "../../features/account-actions/service";
import type { Communities } from "../../features/communities/service";
import { ProfileButton } from "./ProfileButton";

afterEach(cleanup);

it("keeps the header cutout and menu status in sync with presence", () => {
  const listeners = new Set<() => void>();
  let presence = {
    status: "online" as "online" | "away" | "offline",
    preference: "auto",
  };
  const state = { profile: { name: "", picture: "" }, viewer: "a".repeat(64) };
  const connection = { status: "unavailable", session: undefined, scope: "" };
  const subscribe = () => () => {};
  const communities = {
    subscribe,
    snapshot: () => state,
    relay: { subscribe, snapshot: () => connection },
    presence: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => presence,
      setPreference: () => {},
    },
  } as unknown as Communities;
  const actions: readonly [] = [];
  const accountActions = {
    subscribe,
    snapshot: () => actions,
  } as unknown as AccountActionsService;

  render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  const button = screen.getByRole("button", { name: "Your profile" });
  expect(button).toHaveAttribute("data-icon-variant", "avatar");
  expect(button.querySelector(".buzz-avatar svg")).toBeInTheDocument();
  expect(button.querySelector(".buzz-avatar")).not.toHaveTextContent("?");
  expect(button.querySelector(".buzz-avatar-status")).toHaveAttribute(
    "data-status",
    "online",
  );
  fireEvent.click(button);
  expect(
    screen
      .getByRole("button", { name: "Availability: Online" })
      .closest("[data-status]"),
  ).toHaveAttribute("data-status", "online");

  for (const [status, label] of [
    ["away", "Away"],
    ["offline", "Offline"],
  ] as const) {
    act(() => {
      presence = { ...presence, status };
      for (const listener of listeners) listener();
    });
    expect(button.querySelector(".buzz-avatar-status")).toHaveAttribute(
      "data-status",
      status,
    );
    expect(
      screen
        .getByRole("button", { name: `Availability: ${label}` })
        .closest("[data-status]"),
    ).toHaveAttribute("data-status", status);
  }
});

it.each([false, true])(
  "hands Settings focus over after closing without stealing early page focus (%s)",
  async (earlyFocus) => {
    const user = userEvent.setup();
    const snapshot = {
      profile: { name: "Fixture", picture: "" },
      viewer: null,
    };
    const connection = { status: "unavailable", session: undefined, scope: "" };
    const presence = { status: "online", preference: "auto", error: null };
    const subscribe = () => () => {};
    const actions: readonly [] = [];
    const accountActions = {
      subscribe,
      snapshot: () => actions,
    } as unknown as AccountActionsService;
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence },
      relay: { subscribe, snapshot: () => connection },
    } as unknown as Communities;
    function Shell() {
      const [settings, setSettings] = useState(false);
      return (
        <>
          <ProfileButton
            communities={communities}
            accountActions={accountActions}
            settingsSelected={settings}
            onSettings={() => setSettings(true)}
          />
          <main id="main-content" tabIndex={-1}>
            {settings && <input aria-label="Display name" />}
          </main>
        </>
      );
    }
    render(<Shell />);
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    const menu = await screen.findByRole("menu", { name: "Fixture" });
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const animations = vi.fn(() => [{ finished }]);
    // Hold the real menu's close-completion boundary, not a guessed delay or
    // a replacement React lifecycle. The production callback runs on release.
    Object.defineProperty(menu, "getAnimations", { value: animations });
    try {
      await user.click(screen.getByRole("menuitem", { name: "Settings" }));
      await waitFor(() => expect(animations).toHaveBeenCalled());
      expect(menu).toBeInTheDocument();
      const input = screen.getByRole("textbox", { name: "Display name" });
      if (earlyFocus) await user.type(input, "Do not save");
      await act(async () => release());
      await waitFor(() => expect(menu).not.toBeInTheDocument());
      expect(earlyFocus ? input : screen.getByRole("main")).toHaveFocus();
      if (earlyFocus) expect(input).toHaveValue("Do not save");
    } finally {
      await act(async () => release());
    }
  },
);

it("shows the selected community name and authenticated avatar without saving a local default", async () => {
  const { createRelaySession } = await import("../../features/relay/session");
  const owner = createRelaySession(null);
  const user = userEvent.setup();
  const viewer = "a".repeat(64);
  let profiles = new Map<string, { name: string; picture?: string }>();
  const listeners = new Set<() => void>();
  const media = vi.fn(
    (url: string) => `/community-media?url=${encodeURIComponent(url)}`,
  );
  const ensure = vi.fn(async () => {});
  const connection = {
    viewer,
    status: "ready",
    session: {
      ...owner.session,
      media,
      profiles: {
        snapshot: () => profiles,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ensure,
      },
    },
  };
  const snapshot = {
    profile: { name: "Local name", picture: "" },
    viewer,
    selected: "https://community.test",
  };
  const presence = { status: "online", preference: "auto", error: null };
  const subscribe = () => () => {};
  const actions: readonly [] = [];
  const accountActions = {
    subscribe,
    snapshot: () => actions,
  } as unknown as AccountActionsService;
  const communities = {
    subscribe,
    snapshot: () => snapshot,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  const view = render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  try {
    expect(
      screen.getByRole("button", { name: "Your profile" }),
    ).toBeInTheDocument();
    act(() => {
      profiles = new Map([
        [
          viewer,
          {
            name: "Community name",
            picture: "https://community.test/media/avatar.png",
          },
        ],
      ]);
      for (const listener of listeners) listener();
    });
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    expect(
      await screen.findByRole("menu", { name: "Community name" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Availability: Online" }),
    ).toBeVisible();
    expect(media).toHaveBeenCalledWith(
      "https://community.test/media/avatar.png",
      "small",
    );
    const button = screen.getByRole("button", { name: "Your profile" });
    expect(screen.getByRole("menu", { name: "Community name" })).toBeVisible();
    expect(button.querySelector("img")).toHaveAttribute(
      "src",
      "/community-media?url=https%3A%2F%2Fcommunity.test%2Fmedia%2Favatar.png",
    );
    act(() => {
      profiles = new Map([[viewer, { name: "Updated name" }]]);
      for (const listener of listeners) listener();
    });
    expect(screen.getByRole("menu", { name: "Updated name" })).toBeVisible();
    expect(button.querySelector("img")).toBeNull();
    expect(snapshot.profile).toEqual({ name: "Local name", picture: "" });
    expect(screen.queryByText("Your profile")).not.toBeInTheDocument();
    expect(screen.queryByText("Your account")).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Set a status" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Status updates are unavailable in this community."),
    ).toBeVisible();
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it.each(["escape", "outside", "reopen"])(
  "cancels a held status opening on %s dismissal",
  async (dismiss) => {
    const { createRelaySession } = await import("../../features/relay/session");
    const owner = createRelaySession(null);
    const user = userEvent.setup();
    let release!: () => void;
    const current = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const viewer = "a".repeat(64);
    const connection = {
      scope: "https://status.test",
      session: {
        ...owner.session,
        statuses: { ...owner.session.statuses, writable: true, current },
      },
    };
    const snapshot = {
      profile: { name: "Local", picture: "http://unsafe.test/avatar" },
      viewer,
    };
    const presence = { status: "online", preference: "auto", error: null };
    const subscribe = () => () => {};
    const actions: readonly [] = [];
    const accountActions = {
      subscribe,
      snapshot: () => actions,
    } as unknown as AccountActionsService;
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence },
      relay: { subscribe, snapshot: () => connection },
    } as unknown as Communities;
    const view = render(
      <>
        <ProfileButton
          communities={communities}
          accountActions={accountActions}
          settingsSelected={false}
          onSettings={() => {}}
        />
        <button type="button">Outside</button>
      </>,
    );
    try {
      expect(view.container.querySelector('img[src^="http:"]')).toBeNull();
      act(() => screen.getByRole("button", { name: "Your profile" }).focus());
      await user.keyboard("{Enter}");
      await screen.findByRole("menu", { name: "Local" });
      await user.click(screen.getByRole("menuitem", { name: "Set a status" }));
      expect(current).toHaveBeenCalledOnce();
      if (dismiss === "outside")
        await user.click(screen.getByRole("button", { name: "Outside" }));
      else await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.queryByRole("menu", { name: "Local" }),
        ).not.toBeInTheDocument(),
      );
      if (dismiss === "reopen") {
        act(() => screen.getByRole("button", { name: "Your profile" }).focus());
        await user.keyboard("{Enter}");
        await screen.findByRole("menu", { name: "Local" });
      }
      await act(async () => release());
      expect(
        screen.queryByRole("dialog", { name: "Set a status" }),
      ).not.toBeInTheDocument();
      if (dismiss === "reopen")
        expect(screen.getByRole("menu", { name: "Local" })).toBeVisible();
    } finally {
      await act(async () => release?.());
      view.unmount();
      owner.dispose();
    }
  },
);

it.each(["online", "away", "offline"] as const)(
  "shares %s presence between trigger and account menu",
  async (status) => {
    const user = userEvent.setup();
    const snapshot = {
      profile: { name: "Fixture", picture: "" },
      viewer: "fixture",
    };
    const presence = {
      status,
      preference: status === "offline" ? "offline" : "auto",
      error: null,
    };
    const setPreference = vi.fn();
    const connection = { status: "unavailable", session: undefined, scope: "" };
    const subscribe = () => () => {};
    const actions: readonly [] = [];
    const accountActions = {
      subscribe,
      snapshot: () => actions,
    } as unknown as AccountActionsService;
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence, setPreference },
      relay: { subscribe, snapshot: () => connection },
    } as unknown as Communities;
    render(
      <ProfileButton
        communities={communities}
        accountActions={accountActions}
        settingsSelected={false}
        onSettings={() => {}}
      />,
    );
    const label = `Your status: ${{ online: "Online", away: "Away", offline: "Offline" }[status]}`;
    expect(screen.getAllByRole("img", { name: label })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    const menu = await screen.findByRole("menu", { name: "Fixture" });
    expect(
      menu.querySelector(
        `.buzz-avatar-status[data-status="${status}"] .buzz-avatar-status-dot[aria-hidden="true"]`,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Availability:/ }),
    ).toHaveTextContent(
      { online: "Online", away: "Away", offline: "Offline" }[status],
    );
    await user.click(screen.getByRole("button", { name: /^Availability:/ }));
    expect(
      (await screen.findAllByRole("menuitemradio")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["Online", "Away", "Offline"]);
    expect(
      screen.getByRole("menuitemradio", {
        name: { online: "Online", away: "Away", offline: "Offline" }[status],
      }),
    ).toBeChecked();
    const next = status === "offline" ? "Online" : "Offline";
    await user.click(screen.getByRole("menuitemradio", { name: next }));
    expect(setPreference).toHaveBeenCalledWith(next.toLowerCase());
  },
);

it("drops the previous community profile on switching and uses local defaults only in Personal space", async () => {
  const { createRelaySession } = await import("../../features/relay/session");
  const owner = createRelaySession(null);
  const viewer = "a".repeat(64);
  const listeners = new Set<() => void>();
  const oldListeners = new Set<() => void>();
  let oldProfile = { name: "Alpha", picture: "https://alpha.test/avatar.png" };
  const alphaProfiles = {
    snapshot: () => new Map([[viewer, oldProfile]]),
    subscribe: (listener: () => void) => {
      oldListeners.add(listener);
      return () => {
        oldListeners.delete(listener);
      };
    },
    ensure: vi.fn(async () => {}),
  };
  let state = {
    viewer,
    selected: "https://alpha.test" as string | null,
    profile: {
      name: "Personal name",
      picture: "https://public.test/local.png",
    },
  };
  let connection = {
    viewer,
    status: "ready",
    session: {
      ...owner.session,
      profiles: alphaProfiles,
      media: (url: string) => url,
    },
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const presence = { status: "online", preference: "auto", error: null };
  const communities = {
    subscribe,
    snapshot: () => state,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  const actions: readonly [] = [];
  const accountActions = {
    subscribe: () => () => {},
    snapshot: () => actions,
  } as unknown as AccountActionsService;
  const view = render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  try {
    const button = screen.getByRole("button", { name: "Your profile" });
    fireEvent.click(button);
    expect(await screen.findByRole("menu", { name: "Alpha" })).toBeVisible();
    expect(button.querySelector("img")).toHaveAttribute(
      "src",
      oldProfile.picture,
    );
    act(() => {
      state = { ...state, selected: "https://beta.test" };
      connection = {
        ...connection,
        session: {
          ...connection.session,
          profiles: {
            ...alphaProfiles,
            snapshot: () => new Map(),
            subscribe: () => () => {},
          },
        },
      };
      for (const listener of listeners) listener();
    });
    expect(screen.getByRole("menu")).not.toHaveAccessibleName("Alpha");
    expect(screen.getByRole("menu")).not.toHaveAccessibleName("Personal name");
    expect(button.querySelector("img")).toBeNull();
    act(() => {
      oldProfile = { ...oldProfile, name: "Late Alpha" };
      for (const listener of oldListeners) listener();
    });
    expect(oldListeners.size).toBe(0);
    expect(screen.getByRole("menu")).not.toHaveAccessibleName("Late Alpha");
    expect(button.querySelector("img")).toBeNull();
    act(() => {
      state = { ...state, selected: null };
      for (const listener of listeners) listener();
    });
    expect(screen.getByRole("menu", { name: "Personal name" })).toBeVisible();
    expect(button.querySelector("img")).toHaveAttribute(
      "src",
      "https://public.test/local.png",
    );
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("refreshes the viewer through the real session after roster setup, not a stale cache", async () => {
  const { createRelaySession } = await import("../../features/relay/session");
  const { keypair, metadata, profile, roster, scriptedTransport } =
    await import("../../features/relay/testing");
  const viewer = keypair();
  const relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: import("../../features/relay/live").LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  live.state({ status: "connected", routes: [] });
  owner.session.channels.ensureList();
  const initialRoster = wire.next();
  const read = vi.fn(owner.session.read);
  const connection = {
    viewer: viewer.pubkey,
    status: "ready",
    session: { ...owner.session, read },
  };
  const snapshot = {
    viewer: viewer.pubkey,
    selected: "https://community.test",
    profile: { name: "Local only", picture: "" },
  };
  const presence = { status: "online", preference: "auto", error: null };
  const subscribe = () => () => {};
  const communities = {
    subscribe,
    snapshot: () => snapshot,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  const actions: readonly [] = [];
  const accountActions = {
    subscribe: () => () => {},
    snapshot: () => actions,
  } as unknown as AccountActionsService;
  const view = render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  try {
    expect(wire.pending).toHaveLength(0);
    await act(async () => {
      initialRoster.respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    });
    await waitFor(() =>
      expect(owner.session.live.snapshot().roster.state).toBe("verified"),
    );
    await waitFor(() =>
      expect(read).toHaveBeenCalledWith(
        [{ kinds: [0], authors: [viewer.pubkey], limit: 5 }],
        expect.objectContaining({
          priority: "background",
          fresh: true,
          signal: expect.any(AbortSignal),
        }),
      ),
    );
    // Status enrichment shares the background lane; finish it before the avatar read.
    await act(async () => {
      for (const request of wire.pending.filter(
        (entry) => entry.filters[0]?.kinds?.[0] !== 0,
      ))
        request.respond([]);
    });
    await waitFor(() =>
      expect(
        wire.pending.some((entry) => entry.filters[0]?.kinds?.[0] === 0),
      ).toBe(true),
    );
    const lookup = wire.pending.find(
      (entry) => entry.filters[0]?.kinds?.[0] === 0,
    );
    if (!lookup) throw new Error("Missing profile read");
    // A disk/live cached record arriving during the fresh read must not suppress it.
    act(() => live.receive([profile(viewer, { name: "Old cached name" })]));
    fireEvent.click(screen.getByRole("button", { name: "Your profile" }));
    await waitFor(() =>
      expect(
        screen.getByRole("menu", { name: "Old cached name" }),
      ).toBeVisible(),
    );
    await act(async () =>
      lookup.respond([
        profile(viewer, { name: "Current community name" }, 1_700_000_001),
      ]),
    );
    expect(
      await screen.findByRole("menu", { name: "Current community name" }),
    ).toBeVisible();
    expect(snapshot.profile.name).toBe("Local only");
    // Unrelated live notifications do not start extra reads.
    act(() => live.state({ status: "connected", routes: [] }));
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("opens a contributed account action and removes it when its registration retires", async () => {
  const user = userEvent.setup();
  const profile = { profile: { name: "Fixture", picture: "" }, viewer: null };
  const presence = { status: "online", preference: "auto", error: null };
  const subscribe = () => () => {};
  const connection = { status: "unavailable", session: undefined, scope: "" };
  const communities = {
    subscribe,
    snapshot: () => profile,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  function Action({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange(open: boolean): void;
  }) {
    return open ? (
      <div role="dialog" aria-label="Feedback">
        <button type="button" onClick={() => onOpenChange(false)}>
          Dismiss feedback
        </button>
      </div>
    ) : null;
  }
  const entry = {
    key: "buzz.feedback/send",
    pluginId: "buzz.feedback",
    title: "Send feedback",
    component: Action,
  };
  let actions = [entry];
  const listeners = new Set<() => void>();
  const accountActions = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => actions,
  } as unknown as AccountActionsService;
  render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Send feedback" }),
  );
  expect(screen.getByRole("dialog", { name: "Feedback" })).toBeInTheDocument();
  await act(async () => {
    actions = [];
    for (const listener of listeners) listener();
  });
  expect(
    screen.queryByRole("dialog", { name: "Feedback" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  expect(
    screen.queryByRole("menuitem", { name: "Send feedback" }),
  ).not.toBeInTheDocument();
});
