import { avatarSource } from "../../shared/avatar-source";
import { useEffect, useSyncExternalStore } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import { templateAgentChoices } from "../../features/agents/choices";
import { useChannelList } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
export function useTemplateCatalog(session: RelaySession) {
  const kit = useSyncExternalStore(
    session.channelKit.subscribe,
    session.channelKit.snapshot,
  );
  // Keep legacy artwork available just as Agents does; its readiness does not
  // gate native selection or preflight.
  const library = useAgentChoices(session);
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
  );
  const list = useChannelList(session.channels);
  useEffect(() => {
    session.channelKit.ensure();
  }, [session]);
  useEffect(() => {
    // Channel discovery/access changes can invalidate a completed archive read.
    if (archives.status === "idle") void session.archives.ensure();
  }, [session, archives.status]);
  const { templates } = library;
  return {
    kit,
    agentsComplete: templates.complete && list.status === "ready",
    agentsPending:
      templates.pending || list.status === "idle" || list.status === "loading",
    agents: templateAgentChoices(library, list)
      .filter((a) => !archives.archived.includes(a.pubkey))
      .map((agent) => {
        const source = avatarSource(
          agent.avatar ??
            library.definitions.find((d) => d.id === agent.definitionId)
              ?.avatar,
        );
        return {
          ...agent,
          avatar: source?.startsWith("data:")
            ? source
            : source
              ? session.media(source, "small")
              : undefined,
        };
      }),
    agentsReady: templates.status === "ready" && archives.status === "ready",
    error: templates.error ?? archives.error ?? list.error,
    refresh: () => {
      void session.channelKit.refresh();
      void session.agentChoices.refresh("templates");
      void session.archives.refresh();
      session.channels.refreshList?.();
    },
  };
}
