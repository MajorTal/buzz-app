#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import {
  address,
  changeStore,
  putRecord,
  readStore,
  taskFile,
} from "../dev/task-store.mjs";
import { parseTask, taskKey } from "../src/bundled/task-details/data.ts";

const help = `Task-thread prototype (local file; no notifications or relay writes)
Usage: node scripts/task.mjs <create|get|list|update|delete> [options]
  --thread <buzz://message?...>   Required except for list; resolved through buzz CLI
  --viewer <owner pubkey>         Account owning the prototype data (not the agent)
  --community <relay URL>         Defaults to BUZZ_RELAY_URL
  --title <text> --description <text> --assignee <pubkey or name>
  --branches <JSON array>         Entries: {id, repository, branch}
  --revision <revision>           Optional update/delete conflict check
BUZZ_TASK_FILE overrides the shared file. Empty assignee clears assignment.
Create refuses an existing task. Delete removes metadata, never the conversation.`;

export function runTask(
  args,
  resolveThread = (link, community) =>
    JSON.parse(
      execFileSync(
        "buzz",
        ["--relay", community, "messages", "thread", "--link", link],
        { encoding: "utf8", timeout: 15000, maxBuffer: 2_000_000 },
      ),
    ),
) {
  return execute();
  async function execute() {
    const { values: v, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: Object.fromEntries(
        [
          "thread",
          "viewer",
          "community",
          "title",
          "description",
          "assignee",
          "branches",
          "revision",
        ]
          .map((k) => [k, { type: "string" }])
          .concat([["help", { type: "boolean" }]]),
      ),
    });
    if (v.help) return { help };
    const [action] = positionals;
    if (
      positionals.length !== 1 ||
      !["create", "get", "list", "update", "delete"].includes(action)
    )
      throw new Error(help);
    const viewer = v.viewer || process.env.BUZZ_DEV_VIEWER;
    if (!/^[0-9a-f]{64}$/.test(viewer ?? ""))
      throw new Error("Provide --viewer with the prototype owner's public key");
    const community = new URL(v.community || process.env.BUZZ_RELAY_URL || "");
    if (
      !["http:", "https:", "ws:", "wss:"].includes(community.protocol) ||
      community.username ||
      community.password ||
      community.pathname !== "/" ||
      community.search ||
      community.hash
    )
      throw new Error("Use a relay origin URL");
    community.protocol = community.protocol.replace("ws", "http");
    const scope = `${community.origin}:${viewer}`;
    const file = taskFile();
    if (action === "list")
      return Object.entries((await readStore(file)).records)
        .filter(
          ([key, record]) =>
            key.startsWith("buzz.local-task.v1:") &&
            address(key)[0] === scope &&
            record.value !== null,
        )
        .map(([key, record]) => ({
          key,
          revision: record.revision,
          ...parseTask(record.value),
        }));
    const link = new URL(v.thread || "");
    const channel = link.searchParams.get("channel");
    const selected = link.searchParams.get("id");
    if (
      link.protocol !== "buzz:" ||
      link.hostname !== "message" ||
      !channel ||
      !/^[0-9a-f]{64}$/.test(selected ?? "")
    )
      throw new Error("Provide a Buzz message link with channel and id");
    const events = resolveThread(v.thread, community.origin);
    const message = events.find((e) => e.id === selected);
    if (!message?.tags.some((t) => t[0] === "h" && t[1] === channel))
      throw new Error("Thread message was not found in that channel");
    const root =
      message.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ||
      selected;
    if (
      !events.some(
        (e) =>
          e.id === root && e.tags.some((t) => t[0] === "h" && t[1] === channel),
      )
    )
      throw new Error("Canonical thread root is unavailable");
    const key = taskKey(scope, channel, root);
    const result = (record) => ({
      key,
      revision: record.revision,
      task: record.value === null ? null : parseTask(record.value),
    });
    if (action === "get") {
      const record = (await readStore(file)).records[key];
      if (!record || record.value === null) throw new Error("Task not found");
      return result(record);
    }
    return changeStore((records) => {
      const record = records[key];
      const exists = record && record.value !== null;
      if (action === "create" ? exists : !exists)
        throw new Error(
          action === "create" ? "Task already exists" : "Task not found",
        );
      const task = parseTask(record?.value ?? null);
      for (const field of ["title", "description", "assignee"])
        if (v[field] !== undefined) task[field] = v[field];
      if (v.branches !== undefined) task.branches = JSON.parse(v.branches);
      return result(
        putRecord(
          records,
          key,
          action === "delete" ? null : JSON.stringify(task),
          v.revision ?? record?.revision ?? null,
        ),
      );
    }, file);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runTask(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(
        result.help
          ? `${result.help}\n`
          : `${JSON.stringify(result, null, 2)}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
