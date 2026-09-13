import { IconRefresh, IconUsers } from "@tabler/icons-react";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { avatarSource } from "../../shared/avatar-source";
import {
  groupAgentLibrary,
  type AgentLibrary,
} from "../../features/agents/library";
import { useEffect, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useRelayConnection } from "../../features/relay/react";

export function AgentsPage({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Agents">
        <div className="h-full min-h-0 overflow-auto p-5 text-body sm:p-8">
          <h1 className="m-0 text-title text-primary">Agents</h1>
          {connection.status === "ready" ? (
            <MyAgents
              key={`${connection.scope}:${connection.generation}`}
              session={connection.session}
            />
          ) : (
            <div className="mt-6">
              <p className="text-body">
                {connection.status === "connecting"
                  ? "Connecting to your community…"
                  : "Connect to a community to browse your agents."}
              </p>
              {connection.status === "error" && (
                <Button onClick={() => relay.retry()}>Retry connection</Button>
              )}
            </div>
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}
function MyAgents({ session }: { session: RelaySession }) {
  const library = session.agentLibrary;
  const archives = session.archives;
  const snapshot = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  const archive = useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  const refresh = () => {
    void library.refresh();
    void archives.refresh();
  };
  useEffect(() => {
    void library.refresh();
    void archives.refresh();
  }, [library, archives]);
  const { groups, custom, unknown } = groupAgentLibrary(
    snapshot,
    (key) => archives.state(key) === "archived",
  );
  const loading = snapshot.status === "loading";
  return (
    <div className="mx-auto mt-2 max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-body text-secondary">Your agents from Buzz.</p>
        <Button
          variant="quiet"
          size="compact"
          disabled={loading || snapshot.status === "unavailable"}
          onClick={refresh}
        >
          <IconRefresh size={16} stroke={2} aria-hidden="true" />
          {snapshot.status === "error" ? "Retry" : "Refresh agents"}
        </Button>
      </div>
      {loading && (
        <p className="text-body" role="status">
          Reading your Buzz library…
        </p>
      )}
      {snapshot.status === "idle" && (
        <p className="text-body" role="status">
          Library cleared. Refresh to read it again.
        </p>
      )}
      {snapshot.status === "unavailable" && (
        <p className="text-body" role="status">
          The current Buzz library is available through the local live
          development host. See README for live setup.
        </p>
      )}
      {snapshot.error && (
        <p className="text-body" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.status === "ready" && (
        <>
          <section aria-label="My agents" className="space-y-3">
            <h2 className="m-0 flex items-center gap-2 text-heading">
              My agents{" "}
              <span className="rounded-md bg-neutral-2 px-2 py-0.5 text-body-sm font-normal text-secondary">
                {groups.length}
              </span>
            </h2>
            {!groups.length && (
              <p className="py-8 text-center text-body text-secondary">
                No selected agents in your Buzz library.
              </p>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
              {groups.map((group) => (
                <AgentCard
                  key={group.id}
                  name={group.name}
                  avatar={group.avatar ?? group.identities[0]?.avatar}
                  identities={group.identities}
                  session={session}
                />
              ))}
            </div>
          </section>
          {!!custom.length && (
            <section aria-label="Custom agents" className="space-y-3">
              <h2 className="m-0 text-heading">Custom agents</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                {custom.map((identity) => (
                  <AgentCard
                    key={identity.pubkey}
                    name={identity.name}
                    avatar={identity.avatar}
                    identities={[identity]}
                    session={session}
                  />
                ))}
              </div>
            </section>
          )}
          {!!unknown.length && (
            <section aria-label="Unknown agents" className="space-y-3">
              <h2 className="m-0 text-heading">Other identities</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                {unknown.map((identity) => (
                  <AgentCard
                    key={identity.pubkey}
                    name={identity.name}
                    avatar={identity.avatar}
                    identities={[identity]}
                    session={session}
                  />
                ))}
              </div>
            </section>
          )}
          {archive.status !== "ready" && (
            <p className="text-body text-secondary">
              Archive visibility is unknown. Library entries remain visible;
              this does not grant channel access.
            </p>
          )}
          <p className="border-t border-primary pt-4 text-body-sm text-secondary">
            Mention existing members with @ in a channel or thread. This is your
            current Buzz library, read-only; keep Buzz running for replies.
          </p>
        </>
      )}
    </div>
  );
}
function AgentCard({
  name,
  avatar,
  identities,
  session,
}: {
  name: string;
  avatar?: string | undefined;
  identities: AgentLibrary["identities"];
  session: RelaySession;
}) {
  const source = avatarSource(avatar);
  const picture = source?.startsWith("data:")
    ? source
    : source
      ? session.media(source)
      : undefined;
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-primary p-4">
      <div className="flex min-h-36 flex-1 items-center justify-center py-5">
        <Avatar alt={name} fallback={name} src={picture ?? null} size="large" />
      </div>
      <h3 className="m-0 truncate text-body font-semibold" title={name}>
        {name}
      </h3>
      {identities.length ? (
        <Accordion
          items={[
            {
              value: "identities",
              title: (
                <span className="flex items-center gap-2">
                  <IconUsers size={16} stroke={2} aria-hidden="true" />
                  <span className="sr-only">{name}: </span>
                  {identities.length}{" "}
                  {identities.length === 1 ? "identity" : "identities"}
                </span>
              ),
              content: (
                <ul className="mt-2 space-y-3 border-t border-primary pt-3">
                  {identities.map((identity) => (
                    <li key={identity.pubkey}>
                      <span className="font-semibold text-primary">
                        {identity.name}
                      </span>
                      <p className="m-0 mt-1 select-all break-all text-mono-sm">
                        {identity.pubkey}
                      </p>
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      ) : (
        <p className="m-0 mt-1 text-body-sm text-secondary">
          No linked identity
        </p>
      )}
    </article>
  );
}
