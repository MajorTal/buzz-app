import { npubEncode } from "nostr-tools/nip19";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
import type { Profile } from "../../features/relay/contracts";
import { AgentCard } from "./AgentCard";
import { ManagedAgentActions } from "./ManagedAgentActions";
import { type AgentInventoryIdentity, localSetups } from "./inventory-model";

/** One complete inventory identity; source selection belongs to the enclosing inventory. */
export function InventoryIdentityCard({
  row,
  state,
  control,
  session,
  destination,
  publicProfiles,
  edit,
  duplicate,
  remove,
  importedId,
}: {
  row: AgentInventoryIdentity;
  state: AgentControlState;
  control: AgentControl;
  session: RelaySession;
  destination: string;
  publicProfiles: ReadonlyMap<string, Profile>;
  edit(agent: AgentView, avatar?: string): void;
  duplicate?: ((agent: AgentView) => void) | undefined;
  remove?: ((agent: AgentView) => void) | undefined;
  importedId: string | null;
}) {
  const data = state.data;
  if (!data) return null;
  const avatar = row.avatar ?? publicProfiles.get(row.pubkey)?.picture;
  // The app runs every saved setup, so each keeps its controls whether or not
  // its community is the one currently selected or connected.
  const setups = localSetups(row, destination);
  return (
    <AgentCard
      name={row.displayName}
      avatar={avatar}
      identities={[{ pubkey: row.pubkey, name: row.displayName }]}
      session={session}
      editable={setups}
      onEdit={setups.length ? edit : undefined}
      onDuplicate={setups.length ? duplicate : undefined}
      onDelete={setups.length ? remove : undefined}
    >
      {setups.map((agent) => (
        <ManagedAgentActions
          key={agent.id}
          agent={agent}
          state={state}
          control={control}
          imported={agent.id === importedId}
        />
      ))}
      {row.unconfiguredSetups.map((agent) => (
        <ManagedAgentActions
          key={agent.id}
          agent={agent}
          state={state}
          control={control}
          imported={agent.id === importedId}
          destination={destination}
          owner={session.viewer ?? ""}
        />
      ))}
      <details className="min-w-0 text-body-sm text-secondary">
        <summary className="cursor-pointer">Identity &amp; sources</summary>
        <div className="flex min-w-0 flex-col gap-2 pt-2">
          {[...row.knownCommunities]
            .filter((community) => community && !row.localSetups.has(community))
            .map((community) => (
              <p key={community} className="m-0 break-all">
                {community}
              </p>
            ))}
          {row.oldBuzzSources.length > 0 && (
            <p className="m-0">
              {row.oldBuzzSources
                .map((source) =>
                  source === "installed"
                    ? "Installed Buzz"
                    : "Development Buzz",
                )
                .join(" · ")}
            </p>
          )}
          <p
            className="m-0 select-all break-all text-mono-sm"
            data-public-key=""
          >
            {npubEncode(row.pubkey)}
          </p>
        </div>
      </details>
    </AgentCard>
  );
}
