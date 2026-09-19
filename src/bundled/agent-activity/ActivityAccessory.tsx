import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { IconDots, IconQuestionMark } from "@tabler/icons-react";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { activityTarget } from "../../features/agents/activity-target";
import { selectProfiles } from "../../features/relay/profile-selection";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./ActivityAccessory.module.css";

/** Capture is leased by plugin activation, never by an individual composer. */
export function ActivityAccessory({
  session,
  channelId,
  threadRootId,
  canOpen,
  open,
}: ComposerAccessoryProps) {
  const summaryPrefix = useId();
  const snapshot = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
    session.agentActivity.snapshot,
  );
  const turns = snapshot.turns.filter(
    (turn) =>
      !threadRootId && turn.channelId === channelId && turn.state !== "ended",
  );
  const typing = snapshot.typing.filter(
    (entry) =>
      entry.channelId === channelId && entry.threadRootId === threadRootId,
  );
  const keys = [...new Set([...turns, ...typing].map((entry) => entry.agent))]
    .sort()
    .join(":");
  useEffect(() => {
    if (keys)
      void session.profiles
        .ensure(keys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, keys]);
  const profiles = useMemo(
    () => selectProfiles(session.profiles, keys ? keys.split(":") : []),
    [session.profiles, keys],
  );
  const identities = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
    profiles.snapshot,
  );
  if (!keys) return null;
  return (
    <section
      className={styles.root}
      data-buzz-ui=""
      aria-label={
        threadRootId
          ? "Agent activity in this thread"
          : "Agent activity in this channel"
      }
    >
      <div className={styles.agents}>
        <Tooltip.Provider>
          {keys.split(":").map((agent) => {
            const summaryId = `${summaryPrefix}-${agent}`;
            const target = activityTarget(agent, channelId);
            if (!canOpen(target)) return null;
            const name =
              identities.get(agent)?.name ?? `Agent ${agent.slice(0, 8)}`;
            const active = turns.filter((turn) => turn.agent === agent);
            const working = active.filter(
              (turn) => turn.state === "working",
            ).length;
            const unknown = active.length - working;
            const isWorking =
              working > 0 || typing.some((entry) => entry.agent === agent);
            const Icon = isWorking ? IconDots : IconQuestionMark;
            const picture = identities.get(agent)?.picture;
            return (
              <Tooltip.Root key={agent}>
                <Tooltip.Trigger
                  render={
                    <Button size="compact" variant="ghost">
                      <span aria-hidden="true">
                        <Avatar
                          src={
                            picture ? (session.media(picture) ?? null) : null
                          }
                          alt=""
                          fallback={name}
                          size="small"
                        />
                      </span>
                      <span className={styles.name}>{name}</span>
                      <span aria-hidden="true">·</span>
                      <span className={styles.status}>
                        {isWorking ? "working" : "status unknown"}
                      </span>
                      <Icon
                        className={styles.indicator}
                        data-working={isWorking || undefined}
                        size={18}
                        aria-hidden="true"
                      />
                    </Button>
                  }
                  aria-label={`View activity for ${name} ${agent.slice(0, 12)}`}
                  aria-describedby={summaryId}
                  onClick={() => open(target)}
                />
                <Tooltip.Portal>
                  <Tooltip.Positioner side="top" sideOffset={8}>
                    <Tooltip.Popup
                      id={summaryId}
                      role="tooltip"
                      data-buzz-ui=""
                      className={styles.summary}
                    >
                      <p className="text-body-sm">
                        {threadRootId ? (
                          "Working in this thread. Details show channel activity, including other threads."
                        ) : (
                          <>
                            {working
                              ? `${working} working turn(s)`
                              : "No fresh working evidence"}
                            {unknown ? ` · ${unknown} with unknown status` : ""}{" "}
                            in this channel, including threads.
                            {isWorking && !working
                              ? " Fresh channel typing signal."
                              : ""}
                          </>
                        )}
                      </p>
                      <p className="text-body-sm text-secondary">
                        Owner-only activity. Select to inspect.
                      </p>
                      <code className="font-mono text-mono">{agent}</code>
                    </Tooltip.Popup>
                  </Tooltip.Positioner>
                </Tooltip.Portal>
              </Tooltip.Root>
            );
          })}
        </Tooltip.Provider>
      </div>
    </section>
  );
}
