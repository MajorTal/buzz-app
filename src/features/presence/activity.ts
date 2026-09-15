/** One app input source; focus and selected community are not availability. */
export function createPresenceActivity() {
  const listeners = new Set<() => void>();
  let last = Date.now(),
    sharedAt = 0;
  let away = false;
  const visible = () =>
    typeof document !== "undefined" && document.visibilityState === "visible";
  let shown = visible();
  const channel =
    typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("buzz-presence-input")
      : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function update() {
    clearTimeout(timer);
    const nextAway = Date.now() - last >= 600000;
    const nextShown = visible();
    if (nextAway !== away || nextShown !== shown) {
      away = nextAway;
      shown = nextShown;
      for (const listener of listeners) listener();
    }
    if (!away)
      timer = setTimeout(update, Math.max(1, last + 600000 - Date.now()));
  }
  const input = () => {
    last = Date.now();
    if (last - sharedAt >= 1000) {
      sharedAt = last;
      channel?.postMessage(last);
    }
    update();
  };
  if (channel)
    channel.onmessage = ({ data }) => {
      if (
        typeof data === "number" &&
        Number.isFinite(data) &&
        data > last &&
        data <= Date.now()
      ) {
        last = data;
        update();
      }
    };
  const events = [
    "pointerdown",
    "pointermove",
    "keydown",
    "wheel",
    "touchstart",
  ];
  if (typeof document !== "undefined") {
    for (const event of events)
      document.addEventListener(event, input, { passive: true });
    document.addEventListener("visibilitychange", update);
    update();
  }
  return {
    status: (): "online" | "away" => (away ? "away" : "online"),
    visible: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      clearTimeout(timer);
      channel?.close();
      listeners.clear();
      if (typeof document !== "undefined") {
        for (const event of events) document.removeEventListener(event, input);
        document.removeEventListener("visibilitychange", update);
      }
    },
  };
}
export type PresenceActivity = ReturnType<typeof createPresenceActivity>;
