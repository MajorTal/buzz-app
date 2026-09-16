// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The transcript supports keyboard scrolling, like the shared message timeline.
import { MessageRow } from "../../features/messages/MessageRow";
import type { CallSnapshot } from "./call";
import styles from "./Bestie.module.css";

const speakers = {
  user: { name: "You" },
  assistant: { name: "Bestie", picture: "/bestie.png" },
};
// Voice transcripts have no relay attachments or profile navigation.
const transcriptMedia = (url: string) =>
  url === "/bestie.png" ? url : undefined;
const openTranscriptLink = () => false;

export function Transcript({
  messages,
}: {
  messages: CallSnapshot["messages"];
}) {
  return (
    <div className={styles.transcriptViewport}>
      <div
        className={styles.transcript}
        role="log"
        tabIndex={0}
        aria-label="Bestie transcript"
        aria-live="polite"
      >
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            row={{
              id: message.id,
              channelId: "bestie-transcript",
              authorId: message.role,
              createdAt: message.createdAt,
              content: message.text,
              mentions: [],
              attachments: [],
              reactions: [],
              participants: [],
              replyCount: 0,
            }}
            profile={speakers[message.role]}
            media={transcriptMedia}
            onOpenLink={openTranscriptLink}
            day={false}
            retry={undefined}
          />
        ))}
      </div>
    </div>
  );
}
