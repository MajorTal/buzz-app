import { useEffect, useSyncExternalStore } from "react";
import { Menu } from "@base-ui/react/menu";
import { Bot, Check, ChevronUp } from "lucide-react";
import type { RelaySession } from "../relay/session";
import { Avatar } from "../../shared/Avatar";
import { avatarSource } from "../../shared/avatar-source";
import completion from "../conversation/Completions.module.css";
import styles from "./Sessions.module.css";

export function AgentChoice({
  session,
  value,
  onChange,
  disabled = false,
  allowed,
  parentName,
  membersOnly,
  emptyLabel = "No agent selected",
  side = "top",
}: {
  session: RelaySession;
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  allowed?: readonly string[] | undefined;
  parentName?: string | undefined;
  membersOnly?: readonly string[] | undefined;
  emptyLabel?: string;
  side?: "top" | "bottom";
}) {
  const library = session.agentLibrary;
  const agents = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  useEffect(() => {
    if (agents.status === "idle") void library.refresh();
  }, [library, agents.status]);
  const identities = agents.identities.filter(
    (agent) => !membersOnly || membersOnly.includes(agent.pubkey),
  );
  const selected = identities.find((agent) => agent.pubkey === value);
  function picture(avatar?: string) {
    const source = avatarSource(avatar);
    return source?.startsWith("data:")
      ? source
      : source
        ? session.media(source, "small")
        : undefined;
  }
  const label = selected
    ? `Change agent: ${selected.name}`
    : value
      ? "Change selected agent"
      : "Choose an agent";
  return (
    <Menu.Root>
      <Menu.Trigger
        className={styles.agentTrigger}
        aria-label={label}
        title={label}
        disabled={disabled}
      >
        {selected ? (
          <Avatar
            name={selected.name}
            src={picture(selected.avatar)}
            className={styles.agentAvatar ?? ""}
          />
        ) : (
          <Bot size={20} aria-hidden="true" />
        )}
        <span className={styles.agentName}>
          {selected?.name ?? "Choose agent"}
        </span>
        <ChevronUp size={12} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side={side}
          align="start"
          sideOffset={8}
          collisionAvoidance={{
            side: "none",
            align: "shift",
            fallbackAxisSide: "none",
          }}
          className={styles.agentPositioner}
        >
          <Menu.Popup
            className={`${completion.popup} ${styles.agentMenu}`}
            data-compact=""
            aria-label="Choose an agent"
          >
            <Menu.RadioGroup
              value={value}
              onValueChange={onChange}
              disabled={disabled}
            >
              <Menu.RadioItem
                value=""
                closeOnClick
                className={`${completion.option} ${styles.agentOption}`}
              >
                <Bot size={24} aria-hidden="true" />
                <span>{emptyLabel}</span>
                <Menu.RadioItemIndicator className={styles.agentCheck}>
                  <Check size={14} />
                </Menu.RadioItemIndicator>
              </Menu.RadioItem>
              {identities.map((agent) => {
                const outside =
                  allowed !== undefined && !allowed.includes(agent.pubkey);
                const duplicateName = agents.identities.some(
                  (other) =>
                    other.pubkey !== agent.pubkey && other.name === agent.name,
                );
                return (
                  <Menu.RadioItem
                    key={agent.pubkey}
                    value={agent.pubkey}
                    closeOnClick
                    className={`${completion.option} ${styles.agentOption}`}
                  >
                    <Avatar
                      name={agent.name}
                      src={picture(agent.avatar)}
                      className={styles.agentAvatar ?? ""}
                    />
                    <span>
                      {agent.name}
                      {duplicateName ? ` · ${agent.pubkey.slice(0, 8)}` : ""}
                      {outside ? " — adds to channel" : ""}
                    </span>
                    <Menu.RadioItemIndicator className={styles.agentCheck}>
                      <Check size={14} />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
            {allowed !== undefined &&
              agents.identities.some(
                (agent) => !allowed.includes(agent.pubkey),
              ) && (
                <p>
                  Adding an agent also adds it to{" "}
                  {parentName ?? "the parent channel"}, with access to its
                  history.
                </p>
              )}
            {agents.status === "loading" && (
              <p role="status">Loading agents…</p>
            )}
            {agents.status === "ready" && !agents.identities.length && (
              <p role="status">No agents found in your Buzz library.</p>
            )}
            {agents.status === "unavailable" && (
              <p role="status">
                Your agent library isn’t available on this connection.
              </p>
            )}
            {agents.status === "error" && (
              <Menu.Item
                className={`${completion.option} ${styles.agentOption}`}
                closeOnClick={false}
                onClick={() => void library.refresh()}
              >
                Retry agent list
              </Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
