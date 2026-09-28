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
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";
import { createWorkflows } from "../../features/workflows/capability";
import { WorkflowLanding } from "./WorkflowLanding";
import type { WorkflowDefinition } from "../../features/workflows/types";
import { fixtureDefinition, fixtureViewer, fixtureYaml } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const channel = (index: number): ChannelSummary => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: `Channel ${index}`,
  channelType: index % 2 ? "stream" : "dm",
});
const author = keypair();
function event(id: string, createdAt = 123): RelayEvent {
  return signed(author, {
    created_at: createdAt,
    kind: 30620,
    tags: [
      ["h", id],
      ["d", fixtureDefinition.id],
    ],
    content: fixtureYaml,
  });
}
function mount(
  initial = [channel(1), channel(2), channel(3)],
  prepare?: (owner: ReturnType<typeof createWorkflows>) => void,
) {
  let channels = initial;
  const reads: {
    ids: readonly string[];
    filters: readonly ReadFilter[];
    signal: AbortSignal | undefined;
    resolve(events: readonly RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const owner = createWorkflows({
    viewer: fixtureViewer,
    outbox: undefined,
    local: undefined,
    host: undefined,
    canAccess: (id) => channels.some((item) => item.id === id),
    reader: {
      read(filters, options) {
        return new Promise((resolve, reject) => {
          reads.push({
            ids: filters.flatMap((filter) => filter["#h"] ?? []),
            filters,
            signal: options?.signal,
            resolve,
            reject,
          });
        });
      },
    },
  });
  prepare?.(owner);
  let refresh = 0;
  let mountKey = 0;
  let saveReadback:
    | Pick<WorkflowDefinition, "channelId" | "revision">
    | undefined;
  const element = () => (
    <StrictMode>
      <WorkflowLanding
        key={mountKey}
        capability={owner.capability}
        channels={channels}
        refreshRequest={refresh}
        saveReadback={saveReadback}
        viewer={fixtureViewer}
        onCreate={() => {}}
        onOpen={() => {}}
      />
    </StrictMode>
  );
  const rendered = render(element());
  return {
    owner,
    reads,
    change(next: ChannelSummary[], revoke = false) {
      channels = next;
      act(() => {
        if (revoke) owner.clear();
        rendered.rerender(element());
      });
    },
    remount() {
      mountKey++;
      rendered.rerender(element());
    },
    refresh() {
      refresh++;
      rendered.rerender(element());
    },
    readback(channelId: string, revision: string) {
      saveReadback = { channelId, revision };
      rendered.rerender(element());
    },
    async finish(index: number, events: readonly RelayEvent[] = []) {
      await waitFor(() => expect(reads.length).toBeGreaterThan(index));
      await act(async () => {
        reads[index]?.resolve(events);
      });
    },
    close() {
      rendered.unmount();
      owner.dispose();
      for (const read of reads) read.resolve([]);
    },
  };
}

it("reads 500 mixed member channels in four serial batches and never rereads on metadata reorder", async () => {
  const channels = Array.from({ length: 500 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    await waitFor(() => expect(fixture.reads).toHaveLength(1));
    expect(fixture.reads[0]?.ids).toHaveLength(128);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    fixture.change(
      [...channels].reverse().map((c) => ({ ...c, name: `Renamed ${c.name}` })),
    );
    for (let i = 0; i < 4; i++) {
      expect(fixture.reads).toHaveLength(i + 1);
      await fixture.finish(i);
    }
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow scan finished.",
    );
    expect(fixture.reads.map((r) => r.ids.length)).toEqual([
      128, 128, 128, 116,
    ]);
    expect(fixture.reads.flatMap((r) => r.ids)).toEqual(
      channels.map((c) => c.id),
    );
    fixture.change(channels);
    expect(fixture.reads).toHaveLength(4);
  } finally {
    fixture.close();
  }
});

it("adds only new IDs, cancels removed batches, ignores late completion, and refreshes deliberately", async () => {
  const [a, b, c, d] = [channel(1), channel(2), channel(3), channel(4)];
  const fixture = mount([a, b]);
  try {
    await waitFor(() => expect(fixture.reads).toHaveLength(1));
    fixture.change([c, a, b]);
    fixture.change([a, c, d]);
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    expect(fixture.reads[0]?.signal?.aborted).toBe(true);
    await fixture.finish(0, [event(b.id)]);
    await fixture.finish(1, [event(a.id)]);
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(1);
    expect(fixture.reads.map((r) => r.ids)).toEqual([
      [a.id, b.id],
      [a.id, c.id, d.id],
    ]);
    fixture.refresh();
    await fixture.finish(2);
    expect(fixture.reads[2]?.ids).toEqual([a.id, c.id, d.id]);
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
  } finally {
    fixture.close();
  }
});

it("purges globally without automatic reads and recovers remaining channels on membership removal", async () => {
  const [a, b, c] = [channel(1), channel(2), channel(3)];
  const fixture = mount([a, b, c]);
  try {
    await fixture.finish(0, [event(a.id), event(b.id)]);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    fixture.change([a, c], true);
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);
    await fixture.finish(1, [event(b.id)]);
    await fixture.finish(2, [event(a.id)]);
    expect(fixture.reads[2]?.ids).toEqual([a.id, c.id]);
    act(() => fixture.owner.clear());
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "cleared or unavailable",
    );
    fixture.change([c, a]);
    expect(fixture.reads).toHaveLength(3);
    fixture.refresh();
    await fixture.finish(3);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow scan finished.",
    );
  } finally {
    fixture.close();
  }
});

it("finishes paging before the next batch, resets its cursor, and retains loaded cards on retry", async () => {
  const channels = Array.from({ length: 129 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    const page = Array.from({ length: 100 }, (_, i) =>
      event(channel(1).id, 100 + i),
    );
    await fixture.finish(0, page);
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    expect(fixture.reads[1]?.filters).toEqual([
      {
        kinds: [30620],
        "#h": channels.slice(0, 128).map((c) => c.id),
        limit: 100,
        until: 100,
        before_id: page[0]?.id,
      },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("Reading workflows");
    await fixture.finish(1, [event(channel(2).id, 99)]);
    await waitFor(() => expect(fixture.reads).toHaveLength(3));
    expect(fixture.reads[2]?.filters).toEqual([
      {
        kinds: [30620],
        "#h": [channel(129).id],
        limit: 100,
      },
    ]);
    await act(async () => fixture.reads[2]?.reject(new Error("offline")));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fixture.reads).toHaveLength(4));
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(2);
    const nextPage = Array.from({ length: 100 }, (_, i) =>
      event(channel(129).id, 200 + i),
    );
    await fixture.finish(3, nextPage);
    await waitFor(() => expect(fixture.reads).toHaveLength(5));
    expect(fixture.reads[4]?.filters).toEqual([
      {
        kinds: [30620],
        "#h": [channel(129).id],
        limit: 100,
        until: 200,
        before_id: nextPage[0]?.id,
      },
    ]);
    await fixture.finish(4);
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(3);
    expect(screen.queryByText(/returned a partial workflow list/)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow scan finished.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  } finally {
    fixture.close();
  }
});

it("stops queued batches on interruption, retains cards and resumes on refresh", async () => {
  const channels = Array.from({ length: 257 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    await fixture.finish(0, [event(channel(1).id)]);
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    act(() => fixture.owner.interrupt());
    await fixture.finish(1, [event(channel(129).id)]);
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);
    expect(fixture.reads).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(1);
    expect(screen.queryByText("Reading workflows…")).toBeNull();
    fixture.refresh();
    for (let i = 2; i < 5; i++) await fixture.finish(i);
    expect(fixture.reads.slice(2).flatMap((r) => r.ids)).toEqual(
      channels.map((c) => c.id),
    );
  } finally {
    fixture.close();
  }
});

it("keeps session purge coverage after removing a completed batch member without rereading", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [event(a.id)]);
    fixture.change([a]);
    act(() => fixture.owner.clear());
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
    expect(fixture.reads).toHaveLength(1);
    fixture.refresh();
    await fixture.finish(1, [event(a.id)]);
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();
  } finally {
    fixture.close();
  }
});

it("retains cards and explicit retry after removing a completed batch member then interrupting", async () => {
  const [a, b, c] = [channel(1), channel(2), channel(3)];
  const fixture = mount([a, b, c]);
  try {
    await fixture.finish(0, [event(a.id), event(b.id), event(c.id)]);
    fixture.change([a, c]);
    expect(fixture.reads).toHaveLength(1);
    act(() => fixture.owner.interrupt());
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow discovery paused.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await fixture.finish(1, [event(a.id)]);
    expect(fixture.reads[1]?.ids).toEqual([a.id]);
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(2);
    act(() => fixture.owner.clear());
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
    expect(fixture.reads).toHaveLength(2);
  } finally {
    fixture.close();
  }
});

it("retains a batch's loaded cards when its refresh fails", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [event(a.id), event(b.id)]);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    await act(async () => fixture.reads[1]?.reject(new Error("offline")));
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    fixture.refresh();
    await fixture.finish(2);
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
  } finally {
    fixture.close();
  }
});

it("does not reread recovered channels when a membership is added after explicit recovery", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a]);
  try {
    await fixture.finish(0);
    act(() => fixture.owner.clear());
    fixture.refresh();
    await fixture.finish(1);
    fixture.change([a, b]);
    await fixture.finish(2);
    expect(fixture.reads.map((r) => r.ids)).toEqual([[a.id], [a.id], [b.id]]);
  } finally {
    fixture.close();
  }
});

for (const interrupt of [false, true]) {
  it(`pauses honestly on ${interrupt ? "interruption" : "read failure"} and retries only unfinished batches`, async () => {
    const channels = Array.from({ length: 300 }, (_, i) => channel(i + 1));
    const fixture = mount(channels);
    try {
      await fixture.finish(0, [event(channel(1).id)]);
      await waitFor(() => expect(fixture.reads).toHaveLength(2));
      await act(async () => {
        if (interrupt) fixture.owner.interrupt();
        else fixture.reads[1]?.reject(new Error("offline"));
      });
      if (interrupt) await fixture.finish(1);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Workflow discovery paused.",
      );
      expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
      expect(document.querySelectorAll(".workflow-card-grid > *")).toHaveLength(
        2,
      );
      const remaining = [...channels.filter((_, i) => i !== 130), channel(301)];
      fixture.change([...remaining].reverse());
      expect(fixture.reads).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      const expected = remaining.filter(
        (c) =>
          interrupt || !channels.slice(0, 128).some((old) => old.id === c.id),
      );
      for (let i = 0; i < Math.ceil(expected.length / 128); i++)
        await fixture.finish(
          2 + i,
          interrupt && i === 0 ? [event(channel(1).id)] : [],
        );
      expect(fixture.reads.slice(2).flatMap((r) => r.ids)).toEqual(
        expected.map((c) => c.id),
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "Workflow scan finished.",
      );
      expect(
        screen.getByRole("button", { name: "Open Message helper" }),
      ).toBeVisible();
    } finally {
      fixture.close();
    }
  });
}

it("reports synchronous view admission failure once and retries its unread roster", async () => {
  const blockers: { dispose(): void }[] = [];
  const fixture = mount([channel(1), channel(2)], (owner) => {
    for (let i = 0; i < 16; i++)
      blockers.push(owner.capability.definitions(channel(1).id));
  });
  try {
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow discovery paused.",
    );
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(fixture.reads).toHaveLength(0);
    for (const view of blockers) view.dispose();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await fixture.finish(0);
    expect(fixture.reads.map((r) => r.ids)).toEqual([
      [channel(1).id, channel(2).id],
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow scan finished.",
    );
  } finally {
    for (const view of blockers) view.dispose();
    fixture.close();
  }
});

it("queues verified readback after an older pending read and rereads only the saved channel", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    fixture.readback(a.id, "first-revision");
    expect(fixture.reads).toHaveLength(2);
    expect(fixture.reads[1]?.signal?.aborted).toBe(false);
    await fixture.finish(1);
    await fixture.finish(2, [event(a.id)]);
    expect(fixture.reads.map((read) => read.ids)).toEqual([
      [a.id, b.id],
      [a.id, b.id],
      [a.id],
    ]);
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();
    fixture.change([b, a]);
    expect(fixture.reads).toHaveLength(3);
    fixture.readback(a.id, "second-revision");
    await fixture.finish(3, [event(a.id, 124)]);
    expect(fixture.reads[3]?.ids).toEqual([a.id]);
    act(() => fixture.owner.clear());
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
    fixture.change([a, b]);
    expect(fixture.reads).toHaveLength(4);
  } finally {
    fixture.close();
  }
});

it("drops queued readback for a removed membership without restoring its card", async () => {
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0);
    fixture.refresh();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    fixture.readback(a.id, "saved-revision");
    fixture.change([b], true);
    expect(fixture.reads[1]?.signal?.aborted).toBe(true);
    await fixture.finish(1, [event(a.id)]);
    await fixture.finish(2);
    expect(fixture.reads[2]?.ids).toEqual([b.id]);
    fixture.readback(a.id, "late-revision");
    expect(fixture.reads).toHaveLength(3);
    expect(
      screen.queryByRole("button", { name: "Open Message helper" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Workflow scan finished.",
    );
  } finally {
    fixture.close();
  }
});

it("reuses fresh session cache and does not replay readback on landing remount", async () => {
  const [a, b] = [channel(1), channel(2)];
  const saved = event(a.id);
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [saved]);
    fixture.readback(a.id, saved.id);
    expect(fixture.reads).toHaveLength(1);
    fixture.remount();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Workflow scan finished.",
      ),
    );
    expect(fixture.reads).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();
  } finally {
    fixture.close();
  }
});

it("rereads an overlapping landing batch after queued verified readback", async () => {
  vi.spyOn(Date, "now").mockImplementation(() => 0);
  const [a, b] = [channel(1), channel(2)];
  const saved = event(a.id);
  const fixture = mount([a, b]);
  try {
    await waitFor(() => expect(fixture.reads).toHaveLength(1));
    fixture.readback(a.id, saved.id);
    expect(fixture.reads).toHaveLength(1);
    await fixture.finish(0);
    await fixture.finish(1, [saved]);
    expect(fixture.reads.map((read) => read.ids)).toEqual([
      [a.id, b.id],
      [a.id],
    ]);
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();

    fixture.remount();
    await waitFor(() => expect(fixture.reads).toHaveLength(3));
    expect(fixture.reads[2]?.ids).toEqual([a.id, b.id]);
    await fixture.finish(2, [saved]);
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();
  } finally {
    fixture.close();
  }
});

it("reuses fresh cached results for every completed batch after navigation", async () => {
  const channels = Array.from({ length: 129 }, (_, i) => channel(i + 1));
  const fixture = mount(channels);
  try {
    await fixture.finish(0, [event(channel(1).id)]);
    await fixture.finish(1, [event(channel(129).id)]);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Workflow scan finished.",
      ),
    );
    expect(fixture.reads.map((read) => read.ids.length)).toEqual([128, 1]);
    fixture.remount();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Workflow scan finished.",
      ),
    );
    expect(fixture.reads).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Open Message helper" }),
    ).toHaveLength(2);
  } finally {
    fixture.close();
  }
});

it("shows stale cached cards on remount while refreshing and retrying", async () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const [a, b] = [channel(1), channel(2)];
  const fixture = mount([a, b]);
  try {
    await fixture.finish(0, [event(a.id)]);
    now = 10_001;
    fixture.remount();
    await waitFor(() => expect(fixture.reads).toHaveLength(2));
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();
    await act(async () => fixture.reads[1]?.reject(new Error("offline")));
    expect(
      screen.getByRole("button", { name: "Open Message helper" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  } finally {
    fixture.close();
  }
});
