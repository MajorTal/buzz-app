export function projectKey(scope: string, channel: string) {
  return `buzz.local-project.v1:${JSON.stringify([scope, channel])}`;
}

export function isProject(
  storage: Pick<Storage, "getItem">,
  scope: string,
  channel: string,
) {
  const value = storage.getItem(projectKey(scope, channel));
  if (value !== null && value !== "true")
    throw new Error(
      "Invalid local project marker. Saved data was not changed.",
    );
  return value === "true";
}
