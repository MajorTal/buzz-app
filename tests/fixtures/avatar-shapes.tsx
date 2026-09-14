// Real avatar consumers with local display-only data, no session/broker/network reads.
import "../../src/shared/styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import { Avatar as LegacyAvatar } from "../../src/shared/Avatar";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { MessageRow } from "../../src/features/messages/MessageRow";
import { MembershipRow } from "../../src/features/messages/MembershipRow";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import artwork from "./design-system/assets/avatar.png";

const agent = "a".repeat(64),
  human = "b".repeat(64);
const profiles = new Map([
  [agent, { name: "Agent", picture: artwork }],
  [human, { name: "Human", picture: artwork }],
]);
const agentPubkeys = new Set([agent]);
const row: ChannelMessage = {
  id: "message",
  authorId: agent,
  channelId: "fixture",
  createdAt: 1,
  content: "A message",
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [agent, human],
  replyCount: 2,
};
function Fixture() {
  useKeyboardFocusVisibility();
  const [opened, setOpened] = useState(false);
  return (
    <main style={{ padding: 24 }}>
      <button type="button">Before avatars</button>
      <section
        aria-label="System avatars"
        style={{ display: "flex", gap: 16, marginBlock: 24 }}
      >
        {(["small", "default", "large"] as const).flatMap((size) =>
          (["circle", "squircle"] as const).map((shape) => (
            <Avatar
              key={`${size}-${shape}`}
              size={size}
              shape={shape}
              src={size === "small" ? undefined : artwork}
              alt={`${size} ${shape}`}
              fallback="Avatar"
            />
          )),
        )}
      </section>
      <section
        aria-label="Legacy avatars"
        style={{ display: "flex", gap: 16, marginBlock: 24 }}
      >
        <LegacyAvatar
          name="Human"
          src={artwork}
          shape="circle"
          className="size-7 rounded-lg"
        />
        <LegacyAvatar
          name="Agent"
          src={artwork}
          shape="squircle"
          className="size-7 rounded-lg"
        />
      </section>
      <MessageRow
        row={{ ...row, agentEnvelope: true }}
        profile={profiles.get(agent)}
        participantProfiles={profiles}
        agentPubkeys={agentPubkeys}
        media={(url) => url}
        canOpenLink={() => true}
        onOpenLink={() => {
          setOpened(true);
          return true;
        }}
        day={false}
        retry={undefined}
        onOpenThread={() => {}}
      />
      <MembershipRow
        row={{
          ...row,
          membership: { type: "member_joined", actor: agent, target: agent },
        }}
        profiles={profiles}
        agentPubkeys={agentPubkeys}
        media={(url) => url}
        day={false}
      />
      {opened && <p role="status">Profile opened</p>}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
