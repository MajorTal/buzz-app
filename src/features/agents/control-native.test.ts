import { expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { nativeAgentControlHost } from "./control-native";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
it("browser constructs no native capability", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  expect(nativeAgentControlHost()).toBeNull();
});
it("all command names and camelCase payloads match the native contract", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const host = nativeAgentControlHost();
  if (!host) throw new Error("Missing fixture host");
  await host.snapshot();
  vi.mocked(invoke).mockImplementation(async (name) =>
    name === "agent_control_log_challenge" ? "nonce-fixture" : ("" as never),
  );
  const authorize = vi.fn(async () => "signature-fixture");
  await host.readLog?.({
    id: "exact-id",
    pubkey: "a".repeat(64),
    relayUrl: "wss://relay.example",
    authorize,
  });
  expect(authorize).toHaveBeenCalledWith(
    { id: "exact-id", pubkey: "a".repeat(64), relayUrl: "wss://relay.example" },
    "nonce-fixture",
  );
  await host.installGoose?.();
  const edit = {
    name: "Agent",
    systemPrompt: "Prompt",
    workspace: "/fixture",
    harness: { command: "acp", args: [""], model: "", provider: "" },
    environment: { KEY: null },
  };
  await host.save("exact-id", 3, edit);
  await host.delete?.("exact-id", 3);
  await host.action("exact-id", "stop");
  await host.setStartOnAppLaunch?.("exact-id", false);
  await host.previewImport("development", "wss://chosen.example");
  await host.commitImport("exact-preview", ["exact-id"]);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["agent_control_snapshot"],
    [
      "agent_control_log_challenge",
      {
        id: "exact-id",
        pubkey: "a".repeat(64),
        relayUrl: "wss://relay.example",
      },
    ],
    [
      "agent_control_read_log",
      {
        id: "exact-id",
        pubkey: "a".repeat(64),
        relayUrl: "wss://relay.example",
        nonce: "nonce-fixture",
        signature: "signature-fixture",
      },
    ],
    ["goose_install"],
    ["agent_control_save", { id: "exact-id", expectedRevision: 3, edit }],
    ["agent_control_delete", { id: "exact-id", expectedRevision: 3 }],
    ["agent_control_action", { id: "exact-id", action: "stop" }],
    ["agent_control_start_on_app_launch", { id: "exact-id", enabled: false }],
    [
      "agent_control_import_preview",
      { source: "development", destination: "wss://chosen.example" },
    ],
    [
      "agent_control_import_commit",
      { token: "exact-preview", ids: ["exact-id"] },
    ],
  ]);
});
it("model operations use explicit ticket commands and no construction-time invocation", async () => {
  vi.mocked(invoke).mockClear();
  vi.mocked(isTauri).mockReturnValue(true);
  const models = nativeAgentControlHost()?.models;
  expect(invoke).not.toHaveBeenCalled();
  const request = {
    id: "sample",
    expectedRevision: 1,
    edit: {
      name: "Sample",
      systemPrompt: "",
      workspace: "/tmp",
      harness: {
        command: "buzz-agent",
        args: [],
        model: "",
        provider: "databricks_v2",
      },
      environment: {},
    },
    host: "https://example.com",
    filter: "",
    action: "refresh" as const,
  };
  await models?.begin();
  await models?.run(12, request);
  await models?.cancel(12);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["agent_models_begin"],
    ["agent_models_run", { ticket: 12, request }],
    ["agent_models_cancel", { ticket: 12 }],
  ]);
});

it("mention replay floor is transient IPC input on the existing Start command", async () => {
  vi.mocked(invoke).mockClear();
  vi.mocked(isTauri).mockReturnValue(true);
  await nativeAgentControlHost()?.action("exact-id", "start", 1234567890);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_control_action", {
    id: "exact-id",
    action: "start",
    replayFloor: 1234567890,
  });
});

it("retries only transient host contention for the same one-use log proof", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauri).mockReturnValue(true);
  const commands: string[] = [];
  let challenges = 0;
  let reads = 0;
  vi.mocked(invoke).mockImplementation(async (name) => {
    commands.push(name);
    if (name === "agent_control_log_challenge") {
      if (++challenges < 3)
        throw "Another native agent operation is in progress";
      return "nonce-fixture" as never;
    }
    if (name === "agent_control_read_log") {
      if (++reads < 2) throw "Another native agent operation is in progress";
      return "retained output" as never;
    }
    throw new Error(`Unexpected ${name}`);
  });
  const authorize = vi.fn(async () => "signature-fixture");
  const host = nativeAgentControlHost();
  if (!host?.readLog) throw new Error("Missing fixture host");
  try {
    const read = host.readLog({
      id: "exact-id",
      pubkey: "a".repeat(64),
      relayUrl: "wss://relay.example",
      authorize,
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(await read).toBe("retained output");
    expect(challenges).toBe(3);
    expect(reads).toBe(2);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(commands).toEqual([
      "agent_control_log_challenge",
      "agent_control_log_challenge",
      "agent_control_log_challenge",
      "agent_control_read_log",
      "agent_control_read_log",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("does not retry failed authorization or non-contention native errors", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockRejectedValueOnce("Owner authorization is unavailable");
  const authorize = vi.fn(async () => "signature-fixture");
  const host = nativeAgentControlHost();
  if (!host?.readLog) throw new Error("Missing fixture host");
  const target = {
    id: "exact-id",
    pubkey: "a".repeat(64),
    relayUrl: "wss://relay.example",
    authorize,
  };
  await expect(host.readLog(target)).rejects.toBe(
    "Owner authorization is unavailable",
  );
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(authorize).not.toHaveBeenCalled();

  vi.mocked(invoke).mockReset();
  vi.mocked(invoke)
    .mockResolvedValueOnce("nonce-fixture" as never)
    .mockRejectedValueOnce("Log authorization expired");
  await expect(host.readLog(target)).rejects.toBe("Log authorization expired");
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(authorize).toHaveBeenCalledTimes(1);
});

it("bounds lock-contention retries and never requests a signer when challenge stays busy", async () => {
  vi.useFakeTimers();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockRejectedValue(
    "Another native agent operation is in progress",
  );
  const host = nativeAgentControlHost();
  if (!host?.readLog) throw new Error("Missing fixture host");
  const authorize = vi.fn(async () => "signature-fixture");
  try {
    const read = host.readLog({
      id: "exact-id",
      pubkey: "a".repeat(64),
      relayUrl: "wss://relay.example",
      authorize,
    });
    // Attach the rejection observer before the fake clock can settle the read.
    const outcome = expect(read).rejects.toBe(
      "Another native agent operation is in progress",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(invoke).toHaveBeenCalledTimes(21);
    expect(authorize).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
