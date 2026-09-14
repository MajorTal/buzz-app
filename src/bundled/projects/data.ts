export function projectKey(scope: string, channel: string) {
  return `buzz.local-project.v1:${JSON.stringify([scope, channel])}`;
}

export function isProject(storage: Storage, scope: string, channel: string) {
  const value = storage.getItem(projectKey(scope, channel));
  if (value !== null && value !== "true")
    throw new Error(
      "Invalid local project marker. Saved data was not changed.",
    );
  return value === "true";
}

export function markProject(storage: Storage, scope: string, channel: string) {
  storage.setItem(projectKey(scope, channel), "true");
}
