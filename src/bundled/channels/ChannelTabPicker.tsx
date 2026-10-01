import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RegisteredPanel } from "../../features/panels/service";
import {
  TerminalWindowIcon,
  ListChecksIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import styles from "./ChannelTabs.module.css";

// These existing channel tools accept their context from the host; arbitrary
// target-based contributions still open through their own links.
export function channelToolIcon(panel: RegisteredPanel) {
  return panel.pluginId === "buzz.terminal" ? (
    <TerminalWindowIcon size="1rem" />
  ) : (
    <ListChecksIcon size="1rem" />
  );
}
export function isChannelTabTool(panel: RegisteredPanel) {
  return (
    !!panel.channelLauncher &&
    ((panel.pluginId === "buzz.terminal" && panel.id === "terminal") ||
      (panel.pluginId === "buzz.todos" && panel.id === "todos"))
  );
}
const categories = [
  { id: "channels", label: "Channels" },
  { id: "dm", label: "DMs" },
  { id: "tools", label: "Tools" },
] as const;

export function ChannelTabPicker({
  channels,
  tools,
  icon,
  choose,
  chooseTool,
}: {
  channels: readonly ChannelSummary[];
  tools: readonly RegisteredPanel[];
  icon(channel: ChannelSummary): ReactNode;
  choose(channelId: string): void;
  chooseTool(panel: RegisteredPanel): void;
}) {
  const panelId = useId();
  const input = useRef<HTMLElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const [category, setCategory] = useState<"channels" | "dm" | "tools">(
    "channels",
  );
  const [query, setQuery] = useState("");
  const matches = (name: string) =>
    name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const conversations = channels.filter(
    (channel) =>
      (channel.channelType === "dm") === (category === "dm") &&
      matches(channel.name),
  );
  const matchedTools = tools.filter((tool) => matches(tool.title));
  const empty =
    category === "tools" ? !matchedTools.length : !conversations.length;
  return (
    <section className={styles.picker} aria-label="Choose a tab">
      <div className={styles.pickerLayout}>
        <Tabs
          variant="panel"
          label="Tab categories"
          value={category}
          onValueChange={(value) => {
            setCategory(value);
            setQuery("");
          }}
          items={categories.map(({ id, label }) => ({
            value: id,
            label,
            panelId: `${panelId}-${id}`,
          }))}
        />
        <div
          className={styles.choices}
          role="tabpanel"
          id={`${panelId}-${category}`}
          aria-labelledby={`${panelId}-${category}-tab`}
        >
          <SearchField
            inputRef={input}
            label={
              category === "tools"
                ? "Find a channel tool"
                : "Find a channel or person"
            }
            placeholder={
              category === "tools"
                ? "Search tools…"
                : category === "dm"
                  ? "Search direct messages…"
                  : "Search channels…"
            }
            value={query}
            onValueChange={setQuery}
          />
          <div className={styles.group}>
            {category === "tools"
              ? matchedTools.map((tool) => (
                  <NavigationItem
                    key={tool.key}
                    label={tool.title}
                    icon={channelToolIcon(tool)}
                    onClick={() => chooseTool(tool)}
                  />
                ))
              : conversations.map((channel) => (
                  <NavigationItem
                    key={channel.id}
                    label={channel.name}
                    icon={icon(channel)}
                    onClick={() => choose(channel.id)}
                  />
                ))}
            {empty && (
              <p role="status" className="text-body-sm text-subtle">
                {query.trim()
                  ? "No matches. Try another name."
                  : category === "tools"
                    ? "No channel tools are available. Enable tools in Settings → Plugins. Terminal requires Buzz Desktop."
                    : category === "dm"
                      ? "No direct messages available yet."
                      : "No other channels available yet."}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
