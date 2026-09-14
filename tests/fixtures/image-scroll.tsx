// Actual conversation UI/session and folded events; no live identity or relay.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { foldMessages } from "../../src/features/relay/fold";
import { keypair, message } from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";
const viewer = keypair(),
  relay = keypair();
const events = Array.from({ length: 100 }, (_, i) =>
  message(
    viewer,
    "images",
    `Message ${i}. Reading should survive image loading.`,
    1700000000 + i,
    i % 2 === 0
      ? [
          [
            "imeta",
            `url https://image.test/${i}.svg`,
            "m image/svg+xml",
            "blurhash LEHV6nWB2yk8pyo0adR*.7kCMdnj",
            "thumb https://image.test/forbidden-thumbnail.svg",
            ...(i % 4 === 0 ? ["dim 700x900"] : []),
          ],
        ]
      : [],
  ),
);
const rows = foldMessages("images", relay.pubkey, events);
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url) => url,
  query: async () => [],
  subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <div
      style={{
        height: 700,
        maxWidth: 1100,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ChannelTimeline
        scope="image-scroll"
        channelId="images"
        queries={owner.session}
        window={{
          channelId: "images",
          rows,
          status: "ready",
          hasMore: false,
          loadingOlder: false,
          error: undefined,
          freshness: "fresh",
        }}
        onOpenLink={() => false}
      />
    </div>
  </StrictMode>,
);
