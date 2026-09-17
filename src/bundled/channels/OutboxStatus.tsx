import { Button } from "../../shared/design-system/ui/Button";
import { isWorkflowOperation } from "../../features/workflows/protocol";
import { useState, useSyncExternalStore } from "react";
import type { RelayProfiler } from "../../features/relay/profiling";
import { RelayTimings } from "./RelayTimings";
import type { Outbox } from "../../features/relay/outbox";

/** Delivery belongs to the session, including messages from other pages or a previous launch. */
export function OutboxStatus({
  outbox,
  profiling,
}: {
  outbox: Outbox;
  profiling: RelayProfiler;
}) {
  const operations = useSyncExternalStore(
    outbox.subscribe,
    outbox.snapshot,
    outbox.snapshot,
  );
  const [error, setError] = useState<string>();

  return (
    <details>
      <summary>Outbox · {operations.length} items</summary>
      <p>Removing an item from the outbox does not delete a sent message.</p>
      <ul
        style={{
          maxHeight: "10rem",
          overflow: "auto",
          paddingInlineStart: "1.2rem",
        }}
      >
        {operations.map((item) => (
          <li key={item.event.id}>
            <span>
              {item.event.content.slice(0, 100)} ·{" "}
              {
                {
                  sending: "Sending",
                  accepted: "Sent",
                  unknown: "Unconfirmed",
                  failed: "Not sent",
                  seen: "Sent",
                }[item.delivery]
              }
            </span>{" "}
            {!isWorkflowOperation(item.event) &&
              (item.delivery === "failed" || item.delivery === "unknown") && (
                <Button
                  type="button"
                  onClick={() => outbox.retry(item.event.id)}
                >
                  Retry
                </Button>
              )}{" "}
            {item.delivery !== "sending" && (
              <Button
                type="button"
                onClick={async () => {
                  try {
                    await outbox.dismiss(item.event.id);
                    setError(undefined);
                  } catch (reason) {
                    setError(String(reason));
                  }
                }}
              >
                Remove from outbox
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
      <RelayTimings profiling={profiling} />
    </details>
  );
}
