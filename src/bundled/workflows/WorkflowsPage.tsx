import { useState } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { Button } from "../../shared/design-system/ui/Button";
import { Panel } from "../../shared/design-system/ui/Panel";
import { Select } from "../../shared/design-system/ui/Select";
import { WorkflowChannel } from "./WorkflowChannel";
import { ConfirmAction } from "./ConfirmAction";
import "./workflows.css";

export function WorkflowsPage({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  return (
    <Panel aria-label="Workflows">
      <div className="workflows-page text-body">
        <h1 className="text-title">Workflows</h1>
        <p className="text-secondary">
          Saved automation configurations for this community. The relay runs
          workflows, even when this page is closed.
        </p>
        {connection.status === "ready" ? (
          <WorkflowCommunity
            key={`${connection.scope}:${connection.generation}`}
            session={connection.session}
            viewer={connection.viewer ?? ""}
          />
        ) : (
          <div>
            <p>
              {connection.status === "connecting"
                ? "Connecting to your community…"
                : "Connect to a community to browse workflows."}
            </p>
            {connection.status === "error" && (
              <>
                <p role="alert">{connection.error}</p>
                <Button onClick={() => relay.retry()}>Retry connection</Button>
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
export function WorkflowCommunity({
  session,
  viewer,
}: {
  session: RelaySession;
  viewer: string;
}) {
  const capability = session.workflows;
  const channels = useChannelList(session.channels);
  const [selected, setSelected] = useState("");
  const [draftAtRisk, setDraftAtRisk] = useState(false);
  const [pendingChannel, setPendingChannel] = useState<string | null>(null);
  const channel = channels.channels.find((item) => item.id === selected);
  if (!capability)
    return (
      <p role="status">Workflow operations are unavailable from this host.</p>
    );
  return (
    <>
      {channels.status === "loading" && <p role="status">Reading channels…</p>}
      {channels.status === "error" && (
        <div>
          <p role="alert" className="text-red-12">
            {channels.error ?? "Channels could not be read."}
          </p>
          <Button onClick={() => session.channels.refreshList?.()}>
            Retry channels
          </Button>
        </div>
      )}
      {channels.channels.length > 0 && (
        <Select
          label="Channel"
          value={channel?.id ?? ""}
          groups={[
            {
              label: "Community channels",
              options: [
                { value: "", label: "Choose a channel" },
                ...channels.channels.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ],
            },
          ]}
          onValueChange={(next) => {
            if (next === selected) return;
            if (draftAtRisk) setPendingChannel(next);
            else setSelected(next);
          }}
        />
      )}
      {channels.status === "ready" && !channels.channels.length && (
        <p>No channels are available in this community.</p>
      )}
      {channels.coverage === "partial" && (
        <p className="text-secondary">The channel list is partial.</p>
      )}
      {pendingChannel !== null && (
        <ConfirmAction
          title="Change channel?"
          description="Unsaved draft changes will be discarded. Submitted operations remain with their original channel; switching does not cancel or repeat them."
          action="Change channel"
          onCancel={() => setPendingChannel(null)}
          onConfirm={() => {
            setSelected(pendingChannel);
            setPendingChannel(null);
          }}
        />
      )}
      {channel ? (
        <WorkflowChannel
          key={channel.id}
          capability={capability}
          channelId={channel.id}
          channelName={channel.name}
          viewer={viewer}
          onDraftRiskChange={setDraftAtRisk}
        />
      ) : (
        channels.channels.length > 0 && (
          <p>Choose a channel to read its saved configurations.</p>
        )
      )}
    </>
  );
}
