import { useSyncExternalStore, type ReactNode } from "react";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import type { RelaySession } from "../../features/relay/session";
import styles from "./Channels.module.css";

// Exact block/buzz composer typing copy (TypingIndicatorRow formatTypingLabel).
export function formatTypingLabel(names: readonly string[]) {
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  if (names.length === 3)
    return `${names[0]}, ${names[1]}, and ${names[2]} are typing...`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} others are typing...`;
}

/**
 * Remote human typing anywhere in a DM, including its threads, from the session
 * store. While someone types, the dots replace the DM identity (Slack-style).
 */
export function DmTypingBadge({
  session,
  channelId,
  children,
}: {
  session: RelaySession;
  channelId: string;
  children: ReactNode;
}) {
  // Select a per-row primitive so unrelated typing changes do not re-render
  // this row. Pubkeys are hex; a signer typing in several scopes appears once.
  const typing = useSyncExternalStore(session.typing.subscribe, () => {
    const pubkeys = new Set<string>();
    for (const entry of session.typing.snapshot())
      if (entry.channelId === channelId) pubkeys.add(entry.pubkey);
    return [...pubkeys].join(",");
  });
  const pubkeys = typing ? typing.split(",") : [];
  // Idle rows read no names or profiles.
  return pubkeys.length ? (
    <TypingDots session={session} channelId={channelId} pubkeys={pubkeys}>
      {children}
    </TypingDots>
  ) : (
    children
  );
}

function TypingDots({
  session,
  channelId,
  pubkeys,
  children,
}: {
  session: RelaySession;
  channelId: string;
  pubkeys: readonly string[];
  children: ReactNode;
}) {
  const resolveName = useChannelIdentityNames(session, channelId);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  // Human-only: known agents are represented by the Agent working signal.
  // Unclassified signers stay visible until a loaded profile marks them.
  const humans = pubkeys.filter((pubkey) => !profiles.get(pubkey)?.isAgent);
  if (!humans.length) return children;
  // Reuse already available names; optional typing must not trigger profile reads.
  const label = formatTypingLabel(
    humans.map((pubkey) =>
      resolveName(pubkey, profiles.get(pubkey)?.name ?? pubkey.slice(0, 10)),
    ),
  );
  return (
    <span className={styles.typing} role="img" aria-label={label} title={label}>
      <span />
      <span />
      <span />
    </span>
  );
}
