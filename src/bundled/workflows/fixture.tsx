import { createRoot } from "react-dom/client";
import { StrictMode, useState } from "react";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../shared/styles/globals.css";
import "./workflows.css";
import { Panel } from "../../shared/design-system/ui/Panel";
import { Button } from "../../shared/design-system/ui/Button";
import { WorkflowChannel } from "./WorkflowChannel";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureViewer,
} from "./fixtures";

const fixture = createWorkflowFixture();
Object.assign(window, { workflowFixture: fixture });
function Fixture() {
  useKeyboardFocusVisibility();
  const [mounted, setMounted] = useState(true);
  return (
    <main data-buzz-ui="" className="text-body" style={{ padding: 24 }}>
      <p>Offline fixture — no relay or signing identity.</p>
      <div className="workflow-toolbar">
        <Button onClick={() => fixture.finish("succeeded")}>
          Complete exact save
        </Button>
        <Button onClick={() => fixture.finish("succeeded", false)}>
          Complete concurrent head
        </Button>
        <Button onClick={() => fixture.finish("rejected")}>
          Reject operation
        </Button>
        <Button onClick={() => fixture.finish("unknown")}>
          Unknown operation
        </Button>
        <Button onClick={() => fixture.revoke()}>Revoke access</Button>
        <Button onClick={() => setMounted(false)}>Unmount plugin</Button>
        <Button
          onClick={() => {
            document.documentElement.dataset.colorMode =
              document.documentElement.dataset.colorMode === "dark"
                ? "light"
                : "dark";
          }}
        >
          Toggle appearance
        </Button>
      </div>
      <Panel>
        <div className="workflows-page">
          {mounted && (
            <WorkflowChannel
              capability={fixture.capability}
              channelId={fixtureChannel}
              channelName="Fixture channel"
              viewer={fixtureViewer}
            />
          )}
        </div>
      </Panel>
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
