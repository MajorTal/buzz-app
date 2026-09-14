// Local presentation sample; no session, credentials, network or publication.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Bot } from "lucide-react";
import messageStyles from "../../src/features/messages/Messages.module.css";
import styles from "./message-bubbles.module.css";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import { MessageRow } from "../../src/features/messages/MessageRow";
import {
  continuesMessage,
  startsMessageDay,
} from "../../src/features/messages/message-grouping";
import "../../src/shared/styles/globals.css";

const profiles = new Map([
  ["alice", { name: "Alice Chen" }],
  ["viewer", { name: "You" }],
  ["sam", { name: "Sam Rivera" }],
]);
const base = new Date(2026, 8, 11, 10, 30).getTime() / 1000;
const messages: ChannelMessage[] = [
  [
    "alice",
    "Morning! I’ve put together the first pass of the message layouts.",
  ],
  ["alice", "The little details make this feel much more like a conversation."],
  [
    "viewer",
    "Love the direction. Let’s give the bubbles some room to breathe.",
  ],
  ["viewer", "And keep the composer exactly as it is."],
  [
    "sam",
    "A few things to try:\n• Short replies and longer thoughts\n• Reactions and threads\n• Light and dark mode",
  ],
  ["alice", "Here’s the reference: https://example.com/design/message-bubbles"],
  ["viewer", "Looks good — I’ll take a closer look this afternoon."],
  ["sam", ""],
  ["viewer", "This message couldn’t send. You can still retry it."],
].map(([authorId, content], index) => ({
  id: `sample-${index}`,
  channelId: "sample",
  authorId: authorId ?? "alice",
  content: content ?? "",
  createdAt: base + index * 60,
  mentions: [],
  attachments:
    index === 7
      ? [{ url: "https://example.com/layout.png", video: false }]
      : [],
  reactions:
    index === 1 || index === 6
      ? [{ content: "❤️" }, { content: "🙌" }, { content: "✨" }]
      : [],
  replyCount: index === 4 ? 3 : 0,
  participants: index === 4 ? ["alice", "viewer"] : [],
  ...(index === 8 ? { delivery: "failed" as const } : {}),
}));

function TypingPreview({ agent = false }: { agent?: boolean }) {
  return (
    <div
      className={messageStyles.message}
      data-bubble-direction="incoming"
      role="status"
    >
      <div className={messageStyles.avatarSpace} />
      <div className={messageStyles.messageBody}>
        <div className={messageStyles.byline}>
          <strong>{agent ? "Bestie" : "Alice Chen"}</strong>
          {agent && <span className={styles.agentBadge}>Agent</span>}
          <span className={messageStyles.srOnly}>Typing…</span>
        </div>
        <div className={messageStyles.bubbleAnchor}>
          <div
            className={`${messageStyles.avatar} ${agent ? styles.agentAvatar : ""}`}
            aria-hidden="true"
          >
            {agent ? <Bot size={17} /> : "AL"}
          </div>
          <div
            className={`${messageStyles.text} ${styles.typingBubble}`}
            aria-hidden="true"
          >
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Fixture() {
  const [status, setStatus] = useState("");
  const [dark, setDark] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [humanTyping, setHumanTyping] = useState(true);
  const [agentTyping, setAgentTyping] = useState(true);
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--workspace)",
        padding: "20px 12px",
      }}
    >
      <nav
        aria-label="Preview controls"
        style={{
          display: "flex",
          justifyContent: "center",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 16,
        }}
      >
        <button
          type="button"
          onClick={() => {
            document.documentElement.dataset.colorMode = dark
              ? "light"
              : "dark";
            setDark(!dark);
          }}
        >
          Switch to {dark ? "light" : "dark"}
        </button>
        <button type="button" onClick={() => setNarrow(!narrow)}>
          {narrow ? "Channel width" : "Thread width"}
        </button>
        <button
          type="button"
          aria-pressed={humanTyping}
          onClick={() => setHumanTyping(!humanTyping)}
        >
          Human typing
        </button>
        <button
          type="button"
          aria-pressed={agentTyping}
          onClick={() => setAgentTyping(!agentTyping)}
        >
          Agent typing
        </button>
      </nav>
      <section
        aria-label="Bubble preview"
        style={{
          width: "100%",
          maxWidth: narrow ? 360 : 760,
          margin: "0 auto",
          padding: "16px 12px 24px",
          background: "var(--surface)",
          borderRadius: 24,
        }}
      >
        <strong style={{ padding: "0 12px" }}># design</strong>
        {messages.map((row, index) => (
          <MessageRow
            key={row.id}
            row={row}
            viewer="viewer"
            profile={profiles.get(row.authorId)}
            participantProfiles={profiles}
            day={startsMessageDay(messages[index - 1], row)}
            continuation={continuesMessage(messages[index - 1], row)}
            groupEnd={!continuesMessage(row, messages[index + 1])}
            media={() => undefined}
            onOpenLink={() => {
              setStatus("Opened reference link");
              return true;
            }}
            onOpenThread={(id) => setStatus(`Opened thread for ${id}`)}
            retry={() => setStatus("Retry requested")}
          />
        ))}
        <div id="typing-preview">
          {humanTyping && <TypingPreview />}
          {agentTyping && <TypingPreview agent />}
        </div>
      </section>
      <p
        role="status"
        style={{ textAlign: "center", color: "var(--text-muted)" }}
      >
        {status}
      </p>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing preview root");
createRoot(root).render(<Fixture />);
