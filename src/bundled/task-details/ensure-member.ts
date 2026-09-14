import type { RelaySession } from "../../features/relay/session";

export async function ensureTaskMember(
  session: RelaySession,
  channel: string,
  pubkey: string,
) {
  const isMember = () =>
    session.channels
      .list()
      .channels.find((item) => item.id === channel)
      ?.members?.includes(pubkey);
  if (isMember()) return;
  const outbox = session.outbox;
  if (!outbox?.supports(9000))
    throw new Error(
      "This client cannot add channel members yet. Reload the updated dev client and retry Assign.",
    );
  const id = outbox.send({
    kind: 9000,
    content: "",
    tags: [
      ["h", channel],
      ["p", pubkey],
      ["role", "bot"],
    ],
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const operation = outbox.snapshot().find((item) => item.event.id === id);
    if (operation?.delivery === "failed" || operation?.delivery === "unknown")
      throw new Error(
        operation.error ||
          "Could not confirm adding the agent. Check delivery and retry Assign.",
      );
    if (isMember()) return;
    session.channels.refreshList?.();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    "Agent membership is not confirmed yet. No notification sent; retry Assign after membership updates.",
  );
}
