/** Ordinary channel metadata describes presentation, never access authority. */
export const SESSION_CHANNEL_DESCRIPTION = "Buzz session (buzz.sessions/v1)";
const parentPrefix = `${SESSION_CHANNEL_DESCRIPTION}\nparent:`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sessionDescription(parentId?: string): string {
  return parentId ? `${parentPrefix}${parentId}` : SESSION_CHANNEL_DESCRIPTION;
}
export function sessionMetadata(
  description: string | undefined,
): { parentId?: string } | undefined {
  if (description === SESSION_CHANNEL_DESCRIPTION) return {};
  if (!description?.startsWith(parentPrefix)) return;
  const parentId = description.slice(parentPrefix.length);
  return uuid.test(parentId) ? { parentId } : undefined;
}
