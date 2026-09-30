import { useEffect, useState } from "react";
import type {
  AgentControl,
  AgentLogTarget,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { CopyIcon } from "../../shared/design-system/icons";
import styles from "./Profiles.module.css";

/** The focused view owns only polling while mounted. The native host validates
 * the target on every read and bounds both file retention and response size. */
export function ProfileHarnessLog({
  control,
  target,
  name,
  onBack,
}: {
  control: AgentControl;
  target: AgentLogTarget;
  name: string;
  onBack(): void;
}) {
  const { id, pubkey, relayUrl, authorize } = target;
  const [result, setResult] = useState<{ content: string; error: boolean }>();
  useEffect(() => {
    let active = true;
    setResult(undefined);
    let pending = false;
    const read = () => {
      if (pending || !control.readLog) return;
      pending = true;
      void control.readLog({ id, pubkey, relayUrl, authorize }).then(
        (content) => {
          pending = false;
          if (active) setResult({ content, error: false });
        },
        () => {
          pending = false;
          if (active) setResult({ content: "", error: true });
        },
      );
    };
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") read();
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [control, id, pubkey, relayUrl, authorize]);
  return (
    <PanelSubview
      title="Harness log"
      backLabel="Back to profile"
      onBack={onBack}
    >
      <div className={styles.harnessLog}>
        <div className={styles.logHeader}>
          <div className={styles.logTitle}>
            <small className={styles.logSubtitle}>
              {name} · {pubkey.slice(0, 8)}…{pubkey.slice(-6)}.log
            </small>
          </div>
          <Button
            size="compact"
            variant="ghost"
            disabled={!result || result.error || !result.content}
            onClick={() => {
              if (result && !result.error)
                void Promise.resolve()
                  .then(() => navigator.clipboard.writeText(result.content))
                  .catch(() => {});
            }}
          >
            <CopyIcon size={18} aria-hidden="true" />
            Copy log
          </Button>
        </div>
        {!result ? (
          <div
            role="status"
            aria-label="Loading harness log"
            className={styles.logLoading}
          >
            <span className="sr-only">Loading harness log</span>
            <div aria-hidden="true" className={styles.logLoadingBars}>
              <span className={styles.logLoadingLine} />
              <span className={styles.logLoadingLine} />
              <span className={styles.logLoadingLine} />
              <span className={styles.logLoadingLine} />
            </div>
          </div>
        ) : result.error ? (
          <p role="alert">Could not read harness log.</p>
        ) : (
          <pre
            data-testid="managed-agent-log-content"
            className={styles.logContent}
          >
            {result.content.trim() ? result.content : "No log output yet."}
          </pre>
        )}
      </div>
    </PanelSubview>
  );
}
