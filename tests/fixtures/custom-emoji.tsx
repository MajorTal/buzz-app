// Real production broker transport and session: the spec owns the broker and a local upstream relay.
import { Context } from "@deepseek-ai/cordis";
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import * as emojiPlugin from "../../src/bundled/emoji";
import { CustomEmojiSettings } from "../../src/bundled/emoji/CustomEmojiSettings";
import emojiManifest from "../../src/bundled/emoji/manifest.json";
import { ConversationService } from "../../src/features/conversation/service";
import { MessageComposer } from "../../src/features/messages/MessageComposer";
import { MessageRow } from "../../src/features/messages/MessageRow";
import type { RelayData } from "../../src/features/relay/service";
import { createRelaySession } from "../../src/features/relay/session";
import { connectBrokerTransport } from "../../src/features/relay/transport";
import { createPluginManager } from "../../src/plugins/manager";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

const ctx = new Context();
const manager = createPluginManager(ctx, {
  bundled: [
    { manifest: { ...emojiManifest, apiVersion: 1 }, module: emojiPlugin },
  ],
});
const extensions = new ConversationService(ctx);
window.addEventListener("pagehide", () => {
  void manager.dispose();
  void ctx.fiber.dispose();
});

const communities = ["https://primary.example", "https://secondary.example"];
const communitySessions = await Promise.all(
  communities.map(async (community) => {
    const transport = await connectBrokerTransport("", undefined, community);
    const owner = createRelaySession(transport, {
      outboxStorage: { load: () => [], save() {} },
    });
    owner.session.channels.ensureList();
    owner.session.channels.ensure("c");
    const value = {
      status: "ready",
      generation: 1,
      scope: `${community}:${transport.viewer}`,
      viewer: transport.viewer,
      session: owner.session,
    };
    const relay = {
      snapshot: () => value,
      subscribe: () => () => {},
    } as unknown as RelayData;
    return { community, owner, relay };
  }),
);

function Community({ index }: { index: number }) {
  const item = communitySessions[index];
  if (!item) throw new Error("Missing community");
  const { session } = item.owner;
  const window = useSyncExternalStore(
    (callback) => session.channels.subscribeWindow("c", callback),
    () => session.channels.window("c"),
  );
  return (
    <>
      <h1>Community {new URL(item.community).hostname}</h1>
      <CustomEmojiSettings relay={item.relay} active={() => true} />
      <section aria-label="Messages">
        {(window?.rows ?? []).map((row) => (
          <MessageRow
            extensions={extensions}
            key={row.id}
            row={row}
            session={session}
            scope={item.community}
            profile={{ name: "Fixture Reader" }}
            media={session.media}
            onOpenLink={() => false}
            day={false}
            retry={undefined}
          />
        ))}
      </section>
      <MessageComposer
        extensions={extensions}
        session={session}
        scope={item.community}
        channelId="c"
        channelName="general"
      />
    </>
  );
}

function Fixture() {
  const [selected, select] = useState(0);
  return (
    <ToastProvider>
      <main style={{ width: 800, maxWidth: "100%", margin: "20px auto" }}>
        <button type="button" onClick={() => select(selected ? 0 : 1)}>
          Switch community
        </button>
        <Community key={selected} index={selected} />
      </main>
    </ToastProvider>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
createRoot(container).render(<Fixture />);
