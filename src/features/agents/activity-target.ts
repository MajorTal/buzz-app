/** Internal panel target, not an OS deep link or an access grant. */
export type ActivitySelection = Readonly<{ agent: string; channelId?: string }>;
export function activityTarget(agent: string, channelId?: string): string {
  const query = new URLSearchParams({ agent });
  if (channelId) query.set("channel", channelId);
  return `buzz:agent-activity?${query}`;
}
export function activitySelection(
  target: string,
): ActivitySelection | undefined {
  try {
    const url = new URL(target);
    const params = url.searchParams;
    const agent = params.get("agent");
    const channelId = params.get("channel");
    if (
      url.protocol !== "buzz:" ||
      url.pathname !== "agent-activity" ||
      url.host ||
      url.hash ||
      !agent ||
      !/^[0-9a-f]{64}$/.test(agent) ||
      params.getAll("agent").length !== 1 ||
      params.getAll("channel").length > 1 ||
      [...params.keys()].some((key) => key !== "agent" && key !== "channel") ||
      (channelId !== null && (!channelId || channelId.length > 256))
    )
      return;
    return { agent, ...(channelId !== null ? { channelId } : {}) };
  } catch {
    return;
  }
}
