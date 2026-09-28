import { createPortal } from "react-dom";
import { useIdentityNames } from "../../features/identity-names/react";
import { useEffect, useSyncExternalStore } from "react";
import { ArrowsClockwiseIcon } from "../../shared/design-system/icons/index";
import { groupAgentLibrary } from "../../features/agents/library";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentCard } from "./AgentCard";

export function AgentLibrary({
  session,
  headerActions,
}: {
  session: RelaySession;
  headerActions: HTMLElement | null;
}) {
  const resolveName = useIdentityNames(session.names);
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
  const candidates = [
    ...groups.flatMap((group) => group.identities),
    ...custom,
    ...unknown,
  ].map((identity) => identity.pubkey);
  const identityLabel = (identity: { pubkey: string; name: string }) =>
    resolveName(identity.pubkey, identity.name, candidates);
  const loading = snapshot.status === "loading";
  return (
    <div className="mx-auto mt-2 max-w-6xl space-y-section-gap">
      {headerActions &&
        createPortal(
          <Button
            variant="quiet"
            size="compact"
            disabled={loading || snapshot.status === "unavailable"}
            onClick={refresh}
          >
            <ArrowsClockwiseIcon size={16} aria-hidden="true" />
            {snapshot.status === "error" ? "Retry" : "Refresh agents"}
          </Button>,
          headerActions,
        )}
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
          <section
            aria-label="Library templates"
            className="flex flex-col gap-4"
          >
            <h2 className="m-0 flex items-center gap-2 text-heading">
              Library templates{" "}
              <span className="rounded-md bg-surface-inset px-2 py-0.5 text-body-sm font-normal text-secondary">
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
                  identityLabel={identityLabel}
                />
              ))}
            </div>
          </section>
          {!!custom.length && (
            <section aria-label="Custom agents" className="flex flex-col gap-4">
              <h2 className="m-0 text-heading">Custom agents</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                {custom.map((identity) => (
                  <AgentCard
                    key={identity.pubkey}
                    name={identityLabel(identity)}
                    avatar={identity.avatar}
                    identities={[identity]}
                    session={session}
                    identityLabel={identityLabel}
                  />
                ))}
              </div>
            </section>
          )}
          {!!unknown.length && (
            <section
              aria-label="Unknown agents"
              className="flex flex-col gap-4"
            >
              <h2 className="m-0 text-heading">Other identities</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4">
                {unknown.map((identity) => (
                  <AgentCard
                    key={identity.pubkey}
                    name={identityLabel(identity)}
                    avatar={identity.avatar}
                    identities={[identity]}
                    session={session}
                    identityLabel={identityLabel}
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
            This is your current Buzz library, read-only. Templates are not
            managed agents. Open the desktop app to import an existing identity;
            import does not start it or add channel membership.
          </p>
        </>
      )}
    </div>
  );
}
