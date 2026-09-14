import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseTask } from "../src/bundled/task-details/data.ts";

export const taskFile = () =>
  process.env.BUZZ_TASK_FILE ||
  join(homedir(), ".buzz", "task-thread-experiment.json");

export function address(key) {
  const prefix = key?.startsWith("buzz.local-task.v1:")
    ? "buzz.local-task.v1:"
    : "buzz.local-project.v1:";
  if (typeof key !== "string" || !key.startsWith(prefix))
    throw new Error("Invalid record key");
  const parts = JSON.parse(key.slice(prefix.length));
  if (
    !Array.isArray(parts) ||
    parts.length !== (prefix.includes("task") ? 3 : 2) ||
    !parts.every(
      (p) => typeof p === "string" && p.length > 0 && p.length <= 2048,
    )
  )
    throw new Error("Invalid record address");
  return parts;
}

function validate(key, value) {
  address(key);
  if (value === null) return;
  if (typeof value !== "string") throw new Error("Invalid record value");
  if (key.startsWith("buzz.local-task.v1:")) {
    if (!parseTask(value).title.trim())
      throw new Error("Task title is required");
  } else if (value !== "true") throw new Error("Invalid project marker");
}

export async function readStore(file = taskFile()) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, records: {} };
    throw error;
  }
  if (raw.length > 8_000_000) throw new Error("Task file is too large");
  const store = JSON.parse(raw);
  if (store.version !== 1 || !store.records || Array.isArray(store.records))
    throw new Error("Invalid task file; existing data was not changed");
  for (const [key, record] of Object.entries(store.records)) {
    validate(key, record.value);
    if (typeof record.revision !== "string")
      throw new Error("Invalid revision");
  }
  return store;
}

// All writers share this bounded lock and replace one complete file atomically.
export async function changeStore(change, file = taskFile()) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await delay(20);
    }
  }
  if (!acquired)
    throw new Error(
      `Task file is locked. If its writer stopped, remove ${lock} and retry.`,
    );
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const store = await readStore(file);
    const result = change(store.records);
    const raw = JSON.stringify(store, null, 2);
    if (raw.length > 8_000_000) throw new Error("Task file is too large");
    await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    return result;
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true });
  }
}

export function putRecord(records, key, value, expected) {
  validate(key, value);
  if ((records[key]?.revision ?? null) !== expected)
    throw new Error("Task details changed elsewhere. Reload before saving.");
  const record = { value, revision: randomUUID() };
  records[key] = record;
  return record;
}

export function scopeRecords(records, scope) {
  return Object.fromEntries(
    Object.entries(records).filter(([key]) => address(key)[0] === scope),
  );
}
