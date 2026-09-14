export type Task = {
  title: string;
  description: string;
  assignee: string;
  branches: { id: string; repository: string; branch: string }[];
};

export function taskKey(scope: string, channel: string, root: string) {
  return `buzz.local-task.v1:${JSON.stringify([scope, channel, root])}`;
}

export function channelTasks(storage: Storage, scope: string, channel: string) {
  const prefix = `buzz.local-task.v1:${JSON.stringify([scope, channel]).slice(0, -1)},`;
  const tasks: { root: string; task: Task }[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const coordinate = JSON.parse(key.slice("buzz.local-task.v1:".length));
    if (coordinate.length !== 3 || typeof coordinate[2] !== "string")
      throw new Error("Invalid local task address.");
    tasks.push({ root: coordinate[2], task: parseTask(storage.getItem(key)) });
  }
  return tasks.sort((a, b) => a.task.title.localeCompare(b.task.title));
}

export function parseTask(raw: string | null): Task {
  if (raw === null)
    return { title: "", description: "", assignee: "", branches: [] };
  const value = JSON.parse(raw);
  const text = (s: unknown) => typeof s === "string" && s.length <= 16000;
  if (
    !value ||
    !text(value.title) ||
    !text(value.description) ||
    !text(value.assignee) ||
    !Array.isArray(value.branches) ||
    value.branches.length > 20 ||
    !value.branches.every(
      (b: Task["branches"][number]) =>
        b && text(b.id) && text(b.repository) && text(b.branch),
    )
  )
    throw new Error(
      "Stored task details are invalid. The saved record has not been changed.",
    );
  return value;
}

export function saveTask(
  storage: Storage,
  key: string,
  previous: string | null,
  task: Task,
) {
  if (!task.title.trim()) throw new Error("Enter a task title before saving.");
  if (storage.getItem(key) !== previous)
    throw new Error(
      "Task details changed in another window. Reopen this panel before saving.",
    );
  const raw = JSON.stringify(task);
  parseTask(raw);
  storage.setItem(key, raw);
  return raw;
}
