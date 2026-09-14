import { getPublicKey, nip44 } from "nostr-tools";
import { eventDto } from "../src/features/relay/events.ts";
import {
  OBSERVER_KIND,
  observerFrame,
} from "../src/features/agents/observer.ts";

/** Purpose-bound, synchronous decode in the existing key-owning host only.
 * Relay admission establishes the agent/owner relationship; tags alone do not. */
export function decodeAgentObserver(input, secret, viewer) {
  if (getPublicKey(secret) !== viewer)
    throw new Error("Observer viewer changed");
  const event = eventDto(input);
  const exact = (name, value) => {
    const tags = event.tags.filter((tag) => tag[0] === name);
    return tags.length === 1 && tags[0].length === 2 && tags[0][1] === value;
  };
  if (
    event.kind !== OBSERVER_KIND ||
    !exact("p", viewer) ||
    !exact("agent", event.pubkey) ||
    !exact("frame", "telemetry") ||
    event.content.length < 132 ||
    event.content.length > 87472 ||
    Math.abs(event.created_at - Math.floor(Date.now() / 1000)) > 300
  )
    throw new Error("Invalid observer envelope");
  const key = nip44.v2.utils.getConversationKey(secret, event.pubkey);
  try {
    return observerFrame({
      id: event.id,
      agent: event.pubkey,
      createdAt: event.created_at,
      plaintext: nip44.v2.decrypt(event.content, key),
    });
  } finally {
    key.fill(0);
  }
}
