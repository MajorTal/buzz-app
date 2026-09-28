// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render as mount,
  screen,
} from "@testing-library/react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
afterEach(cleanup);
import { renderToStaticMarkup } from "react-dom/server";
import type { RelaySession } from "../../features/relay/session";
import { LiveStatus } from "./LiveStatus";

type Snapshot = ReturnType<RelaySession["live"]["snapshot"]>;
const channel = {
  id: "channel:a",
  channelId: "a",
  status: "live",
  replay: "unknown",
} as const;
const base: Snapshot = {
  status: "connected",
  routes: [channel],
  roster: { state: "verified" },
  heads: [],
};
function render(
  patch: Partial<Snapshot> = {},
  partialRoster = false,
  diagnostics = false,
) {
  const snapshot: Snapshot = { ...base, ...patch };
  const live = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
  };
  const component = (
    <LiveStatus
      live={live}
      channelId="a"
      partialRoster={partialRoster}
      diagnostics={diagnostics}
    />
  );
  if (diagnostics) return renderToStaticMarkup(component);
  cleanup();
  mount(component, { wrapper: ToastProvider });
  return document.querySelector(".buzz-toast")?.textContent ?? "";
}
it.each<Partial<Snapshot>>([
  {},
  { status: "connecting", routes: [] },
  { routes: [] },
  { routes: [{ ...channel, status: "pending" }] },
  {
    routes: [channel, { id: "profiles", status: "pending", replay: "unknown" }],
  },
  { heads: [{ channelId: "a", state: "pending" }] },
  { heads: [{ channelId: "a", state: "deferred" }] },
])(
  "does not turn ordinary setup into a yellow recovery warning: %j",
  (patch) => {
    expect(render(patch)).toBe("");
  },
);
it("reports clean connection progress in diagnostics without a retry action", () => {
  expect(
    render({ routes: [{ ...channel, status: "pending" }] }, false, true),
  ).toContain("connecting");
  expect(render({}, false, true)).toContain("stream established");
  expect(render({ status: "connecting" }, false, true)).not.toContain("button");
});
it.each<Partial<Snapshot>>([
  { status: "error" },
  { status: "retrying" },
  { status: "unavailable" },
  { error: "Socket refused" },
  { routes: [{ ...channel, status: "limited" }] },
  { routes: [{ ...channel, status: "error" }] },
  { heads: [{ channelId: "a", state: "error", error: "Head read failed" }] },
  { roster: { state: "error", error: "Roster refused" } },
  { roster: { state: "deferred" } },
])("retains recovery for degraded coverage or failures: %j", (patch) => {
  expect(render(patch)).toContain("Retry live updates");
});
it.each(["channel", "global"])(
  "keeps bounded pending %s quota recovery in Diagnostics only",
  (owner) => {
    const error = "rate-limited: quota exceeded; retry in 2s";
    const routes: Snapshot["routes"] =
      owner === "channel"
        ? [{ ...channel, status: "pending", error }]
        : [
            channel,
            { id: "profiles", status: "pending", replay: "unknown", error },
          ];
    expect(render({ routes })).toBe("");
    const diagnostics = render({ routes }, false, true);
    expect(diagnostics).toContain("recovering automatically");
    expect(diagnostics).toContain(`Last rejection: ${error}`);
    expect(diagnostics).not.toContain("stream established");
  },
);
const quota = "rate-limited: quota exceeded; retry in 4s";
const recovering = { ...channel, status: "pending", error: quota } as const;
it.each<Partial<Snapshot>>([
  { error: "Socket control failed" },
  { status: "retrying" },
  { roster: { state: "error", error: quota } },
  { heads: [{ channelId: "a", state: "error", error: `ReadError: ${quota}` }] },
  {
    routes: [
      recovering,
      {
        id: "profiles",
        status: "error",
        replay: "unknown",
        error: "Profile stream stopped",
      },
    ],
  },
  { routes: [{ ...channel, status: "error", error: quota }] },
  {
    routes: [
      {
        ...channel,
        status: "pending",
        error: "rate-limited: shared admission unavailable",
      },
    ],
  },
  {
    routes: [
      {
        ...channel,
        status: "pending",
        error: "rate-limited: quota exceeded; retry in 61s",
      },
    ],
  },
  {
    routes: [
      { ...channel, status: "pending", error: "rate-limited: quota exceeded" },
    ],
  },
])(
  "does not hide actionable or unsupported failures behind automatic recovery: %j",
  (patch) => {
    const html = render({ routes: [recovering], ...patch });
    expect(html).toContain("Retry live updates");
    expect(html).not.toContain("retry in 4s");
  },
);
it("a recovering global cannot hide a selected channel failure", () => {
  expect(
    render({
      routes: [
        { ...channel, status: "error", error: "Selected stream stopped" },
        { id: "profiles", status: "pending", replay: "unknown", error: quota },
      ],
    }),
  ).toContain("Selected stream stopped");
});
it("keeps partial roster coverage visible even with healthy established routes", () => {
  expect(render({}, true)).toContain("Some channels are missing");
  expect(render({}, true)).toContain("Retry live updates");
  expect(render({ routes: [recovering] }, true)).toContain(
    "Some channels are missing",
  );
});

it.each(["idle", "pending"] as const)(
  "keeps partial roster coverage quiet while discovery is %s",
  (state) => {
    expect(render({ roster: { state } }, true)).toBe("");
    expect(render({ roster: { state } }, true, true)).not.toContain(
      "Some channels are missing",
    );
  },
);
it.each(["error", "deferred"] as const)(
  "offers roster recovery when partial discovery is %s",
  (state) => {
    const notice = render({ roster: { state } }, true);
    expect(notice).toContain("Channel list needs refreshing.");
    expect(notice).toContain("Retry live updates");
  },
);
it.each<Partial<Snapshot>>([
  { error: "Socket refused" },
  { routes: [{ ...channel, status: "error", error: "Stream stopped" }] },
  { heads: [{ channelId: "a", state: "error", error: "Head read failed" }] },
])("pending partial discovery does not hide another failure: %j", (patch) => {
  const notice = render({ ...patch, roster: { state: "pending" } }, true);
  expect(notice).toContain("Retry live updates");
  expect(notice).not.toContain("Some channels are missing");
});

it("diagnostics does not duplicate notices; changing the selected channel/session replaces recovery ownership", () => {
  const oldRetry = vi.fn();
  const retry = vi.fn();
  const live = (channelId: string, action: () => void) => {
    const snapshot: Snapshot = {
      ...base,
      routes: [{ ...channel, channelId, status: "error" }],
    };
    return {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry: action,
    };
  };
  const oldSession = live("a", oldRetry);
  const newSession = live("b", retry);
  const content = (
    session: typeof oldSession,
    channelId: string,
    visible = true,
  ) => (
    <ToastProvider>
      {visible && (
        <>
          <LiveStatus
            live={session}
            channelId={channelId}
            partialRoster={false}
            diagnostics
          />
          <LiveStatus
            live={session}
            channelId={channelId}
            partialRoster={false}
          />
        </>
      )}
    </ToastProvider>
  );
  const view = mount(content(oldSession, "a"));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  view.rerender(content(newSession, "b"));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry live updates" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(oldRetry).not.toHaveBeenCalled();
  view.rerender(content(newSession, "b", false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
