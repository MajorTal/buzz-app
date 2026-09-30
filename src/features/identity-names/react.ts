import type { NamingIdentity } from "./policy";
import { useSyncExternalStore, useCallback } from "react";
import { useListedChannel } from "../relay/listed-channel";
import type { RelaySession } from "../relay/session";
import type { IdentityNameView } from "./service";
const noop = () => () => {};
const zero = () => 0;
/** The interface arrives through the captured session, never a global lookup. */
export function useIdentityNames(names: IdentityNameView | undefined) {
  const revision = useSyncExternalStore(
    names?.subscribe ?? noop,
    names?.snapshot ?? zero,
    zero,
  );
  return useCallback(
    (
      pubkey: string,
      fallback: string,
      candidates?: readonly string[],
      displayFacts?: readonly NamingIdentity[],
    ): string => {
      // Invalidate memoized labels and completion choices on name changes.
      void revision;
      return (
        names?.resolve(pubkey, fallback, candidates, displayFacts) ?? fallback
      );
    },
    [names, revision],
  );
}

const noMembers: readonly string[] = [];
/** Channel membership defines ambiguity, not the community-wide profile cache. */
export function useChannelIdentityNames(
  session: RelaySession | undefined,
  channelId: string | undefined,
) {
  const members = useListedChannel(
    session?.channels,
    channelId,
    (channel) => channel?.members ?? noMembers,
  );
  const resolve = useIdentityNames(session?.names);
  return useCallback(
    (pubkey: string, fallback: string) => resolve(pubkey, fallback, members),
    [resolve, members],
  );
}
