import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useState } from "react";
import type { ChannelMessage } from "../relay/contracts";
import { DELIVERY_GRACE_MS, deliveryFeedback } from "./delivery";
import styles from "./Messages.module.css";

export function DeliveryNotice({
  row,
  retry,
}: {
  row: ChannelMessage;
  retry?: ((id: string) => void) | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!row.delivery || row.delivery === "seen") return;
    setNow(Date.now());
    const remaining = row.createdAt * 1000 + DELIVERY_GRACE_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [row.createdAt, row.delivery]);
  const feedback = deliveryFeedback(row, now);
  if (!feedback) return null;
  return (
    <div className={styles.delivery}>
      <span role="status">{feedback}</span>
      {(row.delivery === "failed" || row.delivery === "unknown") && retry && (
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => retry(row.id)}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
