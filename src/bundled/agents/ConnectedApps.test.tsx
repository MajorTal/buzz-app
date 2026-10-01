// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AgentAppsHost, ConnectedApp } from "../../features/agents/apps";
import { ConnectedApps } from "./ConnectedApps";

afterEach(cleanup);

const todo: ConnectedApp = {
  name: "todo",
  url: "https://buzz-todo.run402.com/api/mcp",
  added_by: "agent",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function memoryHost(initial: ConnectedApp[] = []): AgentAppsHost {
  let apps = [...initial];
  return {
    list: vi.fn(async () => apps),
    connect: vi.fn(async (_id: string, url: string, name?: string) => {
      if (!url.includes(".run402."))
        throw new Error("App URL must be a run402 app");
      apps = [...apps, { name: name ?? "app", url, added_by: "owner" }];
      return apps;
    }),
    disconnect: vi.fn(async (_id: string, name: string) => {
      apps = apps.filter((a) => a.name !== name);
      return apps;
    }),
  };
}

it("lists apps with who added them and disconnects one", async () => {
  const host = memoryHost([todo]);
  render(<ConnectedApps agentId="a1" host={host} />);
  expect(await screen.findByText(todo.url)).toBeInTheDocument();
  expect(screen.getByText(/added by the agent/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect todo" }));
  expect(await screen.findByText("No connected apps.")).toBeInTheDocument();
  expect(host.disconnect).toHaveBeenCalledWith("a1", "todo");
});

it("connects on Enter without submitting the surrounding settings form", async () => {
  const host = memoryHost();
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <ConnectedApps agentId="a1" host={host} />
    </form>,
  );
  await screen.findByText("No connected apps.");
  const url = screen.getByRole("textbox", { name: "App MCP URL" });
  fireEvent.change(url, {
    target: { value: " https://notes.run402.app/mcp " },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Name (optional)" }), {
    target: { value: "notes" },
  });
  fireEvent.keyDown(url, { key: "Enter" });
  expect(
    await screen.findByText("https://notes.run402.app/mcp"),
  ).toBeInTheDocument();
  expect(host.connect).toHaveBeenCalledWith(
    "a1",
    "https://notes.run402.app/mcp",
    "notes",
  );
  expect(submit).not.toHaveBeenCalled();
  expect(url).toHaveValue("");
});

it("shows the host's refusal and keeps the typed URL", async () => {
  const host = memoryHost();
  render(<ConnectedApps agentId="a1" host={host} />);
  await screen.findByText("No connected apps.");
  const url = screen.getByRole("textbox", { name: "App MCP URL" });
  fireEvent.change(url, { target: { value: "https://evil.example/mcp" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect app" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "must be a run402 app",
  );
  expect(url).toHaveValue("https://evil.example/mcp");
});

it("ignores a slow answer for the previously shown agent", async () => {
  const slow = deferred<ConnectedApp[]>();
  const host: AgentAppsHost = {
    ...memoryHost(),
    list: vi.fn((id: string) =>
      id === "a1" ? slow.promise : Promise.resolve([]),
    ),
  };
  const { rerender } = render(<ConnectedApps agentId="a1" host={host} />);
  rerender(<ConnectedApps agentId="a2" host={host} />);
  expect(await screen.findByText("No connected apps.")).toBeInTheDocument();
  slow.resolve([todo]);
  await waitFor(() => expect(host.list).toHaveBeenCalledTimes(2));
  await slow.promise;
  expect(screen.queryByText(todo.url)).not.toBeInTheDocument();
});
