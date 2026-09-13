// Local-only diagnostic controls; production component in development StrictMode.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AttachmentImage } from "../../src/features/messages/AttachmentImage";
import "../../src/shared/styles/globals.css";

function Fixture() {
  const [source, setSource] = useState("first");
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [hash, setHash] = useState<string | undefined>(
    "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
  );
  const url = `https://image.test/${source}.svg`;
  return (
    <>
      <button type="button" onClick={() => setVisible(true)}>
        Reveal
      </button>
      <button type="button" onClick={() => setSource("next")}>
        Retarget
      </button>
      <button type="button" onClick={() => setSource("failed")}>
        Fail original
      </button>
      <button type="button" onClick={() => setMounted(!mounted)}>
        Toggle mount
      </button>
      <button type="button" onClick={() => setHash(undefined)}>
        No hash
      </button>
      <button type="button" onClick={() => setHash("invalid")}>
        Invalid hash
      </button>
      <div style={{ marginTop: visible ? 20 : 2000 }}>
        {mounted && (
          <AttachmentImage
            attachment={{
              url,
              video: false,
              ...(hash ? { blurhash: hash } : {}),
            }}
            url={url}
            source={url}
            onOpenLink={() => false}
          />
        )}
      </div>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
