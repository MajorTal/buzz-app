import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { changeStore, putRecord, readStore } from "./task-store.mjs";
import { taskStoreHandler } from "./task-store-api.mjs";
import { runTask } from "../scripts/task.mjs";
import { taskKey } from "../src/bundled/task-details/data.ts";

const viewer = "a".repeat(64);
const scope = `https://example.test:${viewer}`;
const root = "b".repeat(64);
const reply = "c".repeat(64);
const key = taskKey(scope, "channel", root);
const task = {
  title: "Muted call",
  description: "",
  assignee: "",
  branches: [],
};
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "buzz-task-test-"));
  const file = join(dir, "tasks.json");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return file;
}

it("serializes writers, rejects stale saves and preserves corrupt files", async () => {
  const file = await fixture();
  const first = await changeStore(
    (r) => putRecord(r, key, JSON.stringify(task), null),
    file,
  );
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      changeStore((r) => {
        const current = JSON.parse(r[key].value);
        putRecord(
          r,
          key,
          JSON.stringify({ ...current, description: current.description + i }),
          r[key].revision,
        );
      }, file),
    ),
  );
  expect(
    JSON.parse((await readStore(file)).records[key].value).description,
  ).toHaveLength(8);
  await expect(
    changeStore(
      (r) => putRecord(r, key, JSON.stringify(task), first.revision),
      file,
    ),
  ).rejects.toThrow("changed elsewhere");
  await writeFile(file, "broken");
  await expect(changeStore(() => {}, file)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("broken");
});

it("CRUD resolves replies to one task and updates only supplied fields", async () => {
  const file = await fixture();
  const old = process.env.BUZZ_TASK_FILE;
  process.env.BUZZ_TASK_FILE = file;
  cleanups.push(() => {
    if (old === undefined) delete process.env.BUZZ_TASK_FILE;
    else process.env.BUZZ_TASK_FILE = old;
  });
  const events = [
    { id: root, tags: [["h", "channel"]] },
    {
      id: reply,
      tags: [
        ["h", "channel"],
        ["e", root, "", "root"],
      ],
    },
  ];
  const args = [
    "--viewer",
    viewer,
    "--community",
    "https://example.test",
    "--thread",
    `buzz://message?channel=channel&id=${reply}`,
  ];
  const call = (op, ...extra) => runTask([op, ...args, ...extra], () => events);
  const created = await call(
    "create",
    "--title",
    "Muted call",
    "--description",
    "Keep next call working",
  );
  expect(created.key).toBe(key);
  await expect(call("create", "--title", "Duplicate")).rejects.toThrow(
    "already exists",
  );
  const assigned = await call("update", "--assignee", "Sol");
  expect(assigned.task.description).toBe("Keep next call working");
  expect((await call("get")).task.assignee).toBe("Sol");
  await expect(
    call("update", "--revision", created.revision, "--title", "stale"),
  ).rejects.toThrow("changed elsewhere");
  const cli = await promisify(execFile)(
    process.execPath,
    [
      "scripts/task.mjs",
      "list",
      "--viewer",
      viewer,
      "--community",
      "https://example.test",
    ],
    { env: { ...process.env, BUZZ_TASK_FILE: file } },
  );
  expect(JSON.parse(cli.stdout)).toHaveLength(1);
  await call("update", "--assignee", "");
  expect((await call("get")).task.assignee).toBe("");
  expect((await call("delete")).task).toBeNull();
  await expect(call("get")).rejects.toThrow("not found");
});

it("serves scoped records, enforces origin, and imports without resurrecting deletions", async () => {
  const file = await fixture();
  const handler = taskStoreHandler({ viewer, file });
  const server = createServer((req, res) =>
    handler(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/api/experiment/tasks?scope=${encodeURIComponent(scope)}`;
  const post = (body, from = origin) =>
    fetch(url, {
      method: "POST",
      headers: { Origin: from, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post({}, "https://evil.example")).status).toBe(403);
  expect(
    (await fetch(`${origin}/api/experiment/tasks?scope=other`)).status,
  ).toBe(403);
  const first = await (
    await post({
      action: "put",
      key,
      value: JSON.stringify(task),
      expected: null,
    })
  ).json();
  expect(first[key].revision).toBeTruthy();
  expect(
    (
      await post({
        action: "put",
        key,
        value: JSON.stringify(task),
        expected: null,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post({
        action: "put",
        key,
        value: null,
        expected: first[key].revision,
      })
    ).status,
  ).toBe(200);
  await post({ action: "import", records: { [key]: JSON.stringify(task) } });
  expect((await (await fetch(url)).json())[key].value).toBeNull();
  await changeStore(
    (r) =>
      putRecord(r, taskKey("other", "c", root), JSON.stringify(task), null),
    file,
  );
  expect(Object.keys(await (await fetch(url)).json())).toEqual([key]);
});
