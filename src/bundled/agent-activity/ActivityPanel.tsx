import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  activitySelection,
  type ActivitySelection,
} from "../../features/agents/activity-target";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Select } from "../../shared/design-system/ui/Select";
import { Button } from "../../shared/design-system/ui/Button";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";

export function ActivityPanel({
  relay,
  target = "",
}: {
  relay: RelayData;
  target?: string;
}) {
  const connection = useRelayConnection(relay);
  if (connection.status !== "ready")
    return (
      <p className="p-4 text-body">
        Connect to a community to view agent activity.
      </p>
    );
  return (
    <ActivityDetails
      key={`${connection.scope}:${connection.generation}:${target}`}
      session={connection.session}
      selection={activitySelection(target)}
    />
  );
}
export function ActivityDetails({
  session,
  selection,
}: {
  session: RelaySession;
  selection?: ActivitySelection | undefined;
}) {
  const activity = session.agentActivity;
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot,
  );
  const agents = useMemo(
    () => [...new Set(snapshot.records.map((row) => row.agent))],
    [snapshot.records],
  );
  const [selected, select] = useState(selection?.agent ?? "");
  const [channelId, selectChannel] = useState(selection?.channelId ?? "");
  const agentChoices = useMemo(
    () => [...new Set([...agents, ...(selected ? [selected] : [])])],
    [agents, selected],
  );
  const profiles = useMemo(
    () => selectProfiles(session.profiles, agentChoices),
    [session.profiles, agentChoices],
  );
  // Reuse already loaded channel labels; opening activity does not scan a directory.
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  ).channels;
  const identities = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
    profiles.snapshot,
  );
  const agent = selected || agents[0] || "";
  const [expanded, expand] = useState<string[]>([]);
  const agentRecords = snapshot.records.filter((row) => row.agent === agent);
  const records = agentRecords.filter(
    (row) => !channelId || row.channelIds.includes(channelId),
  );
  const channelChoices = [
    ...new Set([
      ...agentRecords.flatMap((row) => row.channelIds),
      ...(channelId ? [channelId] : []),
    ]),
  ];
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    region.current?.focus();
  }, []);
  // Keep expansion intent as bounded as the underlying RAM journal.
  useEffect(() => {
    const ids = new Set(snapshot.records.map((row) => row.id));
    expand((previous) =>
      previous.every((id) => ids.has(id))
        ? previous
        : previous.filter((id) => ids.has(id)),
    );
  }, [snapshot.records]);
  const turns = snapshot.turns.filter(
    (turn) =>
      turn.agent === agent && (!channelId || turn.channelId === channelId),
  );
  const working = turns.filter((turn) => turn.state === "working").length;
  const unknown = turns.filter((turn) => turn.state === "unknown").length;
  return (
    <section
      ref={region}
      tabIndex={-1}
      data-buzz-ui=""
      aria-label="Agent activity"
      className="flex min-w-0 flex-col gap-4 p-4 text-body text-primary"
    >
      <h2 className="text-heading">Agent activity</h2>
      <p className="text-body-sm text-secondary">
        Live, owner-only telemetry received while this plugin is enabled. This
        is not a complete ACP recording; publication must be enabled on the
        agent.
      </p>
      {snapshot.status === "unavailable" ? (
        <p>
          This host cannot decode agent activity. Live activity currently
          requires the development broker.
        </p>
      ) : (
        <>
          <p role="status">
            Feed: {snapshot.status}. Quiet or disconnected means unknown, not
            stopped.
          </p>
          {snapshot.status === "interrupted" && (
            <Button size="compact" onClick={() => session.live.retry()}>
              Retry live feed
            </Button>
          )}
          {!agents.length && !selected ? (
            <p>
              Waiting for live records. Select an agent after its first frame
              arrives; there is no history backfill.
            </p>
          ) : (
            <>
              <Select
                label="Agent"
                value={agent}
                groups={[
                  {
                    label: "Observed agents",
                    options: agentChoices.map((key) => ({
                      value: key,
                      label: `${identities.get(key)?.name ?? "Agent"} · ${key.slice(0, 12)}…`,
                    })),
                  },
                ]}
                onValueChange={(key) => {
                  select(key);
                  expand([]);
                }}
              />
              <code className="break-all font-mono text-mono">{agent}</code>
              <Select
                label="Channel"
                value={channelId}
                groups={[
                  {
                    label: "Activity scope",
                    options: [
                      {
                        value: "",
                        label: "All channels (including unscoped records)",
                      },
                      ...channelChoices.map((id) => ({
                        value: id,
                        label: `${channels.find((channel) => channel.id === id)?.name ?? "Channel"} · ${id}`,
                      })),
                    ],
                  },
                ]}
                onValueChange={(id) => {
                  selectChannel(id);
                  expand([]);
                }}
              />
              {channelId && (
                <p className="text-body-sm text-secondary">
                  Channel-wide, not thread-specific. Matching envelopes are
                  shown intact; a batch may also contain other contexts.
                </p>
              )}
              <p role="status">
                {working
                  ? `${working} observed working turn(s).`
                  : "No fresh working evidence."}{" "}
                {unknown
                  ? `${unknown} turn(s) have unknown current state.`
                  : ""}
              </p>
              <p className="text-body-sm text-secondary">
                Working evidence expires after 30 seconds without a fresh turn
                record. Completed means ended, not necessarily succeeded.
              </p>
              {!records.length && (
                <p>
                  Waiting for live records for this identity
                  {channelId ? " in this channel" : ""}. Only owner-visible
                  agent telemetry appears; there is no history backfill.
                </p>
              )}
              <Accordion
                value={expanded}
                onValueChange={expand}
                items={records.map((row) => ({
                  value: row.id,
                  title: `${row.kind} · ${new Date(row.receivedAt).toLocaleTimeString()}`,
                  content: (
                    <div className="min-w-0">
                      <p className="break-all text-body-sm text-secondary">
                        Event {row.id}
                      </p>
                      <pre className="max-h-96 overflow-auto bg-inset p-3 font-mono text-mono">
                        <code>{row.plaintext}</code>
                      </pre>
                    </div>
                  ),
                }))}
              />
            </>
          )}
          {snapshot.trimmed > 0 && (
            <p role="status">
              Retention limited: {snapshot.trimmed} older records or turn states
              discarded.
            </p>
          )}
          <p className="text-body-sm text-secondary">
            RAM only: up to 200 envelopes / 2 MiB and 512 turn states. Cleared
            on disable, cache/access reset, or session replacement.
          </p>
        </>
      )}
    </section>
  );
}
