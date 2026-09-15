import type { ReadTransport } from "../relay/transport";
import type { LiveSubscription } from "../relay/live";
import type { PresenceActivity } from "./activity";

export type PresenceStatus = "online" | "away" | "offline" | "unknown";
type Subject = {
  listeners: Map<() => void, boolean>;
  profiles: number;
  status: PresenceStatus;
  expires: number;
};
const minute = () => 60000 + Math.random() * 5000;
/** Volatile session-owned evidence. No event retention, outbox or live observation. */
export function createPresence(
  transport: ReadTransport | null,
  activity: PresenceActivity | undefined,
  publish: NonNullable<LiveSubscription["publishPresence"]>,
  notify: (listener: () => void) => void,
) {
  const subjects = new Map<string, Subject>();
  const profiles = new Map<string, Subject>();
  let selected = new Map<string, Subject>();
  let connected = false,
    closed = false,
    reading = false;
  let nextRead = Infinity,
    readGate = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let publisher: AbortController | undefined;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let stopPublisher: (() => void) | undefined;
  let lastStatus = activity?.status();
  const change = (subject: Subject, status: PresenceStatus) => {
    if (subject.status === status) return;
    subject.status = status;
    for (const listener of subject.listeners.keys()) notify(listener);
  };
  const eligible = () =>
    !closed &&
    connected &&
    !!transport?.presenceSnapshot &&
    !!activity?.visible();
  function schedule() {
    clearTimeout(timer);
    if (!eligible() || !selected.size) return;
    let wake = reading ? Infinity : nextRead;
    for (const subject of selected.values())
      if (subject.status !== "unknown") wake = Math.min(wake, subject.expires);
    if (Number.isFinite(wake))
      timer = setTimeout(tick, Math.max(0, wake - Date.now()));
  }
  function demand() {
    const previous = selected;
    selected = new Map();
    // Stop each source at the cap. Overflow and duplicate rows must not turn
    // mounting a thread into a full-directory scan per subscription.
    for (const source of [profiles, previous, subjects]) {
      for (const [key, subject] of source) {
        if (selected.size === 256) break;
        if (subjects.get(key) === subject) selected.set(key, subject);
      }
    }
    for (const [key, subject] of previous)
      if (!selected.has(key)) {
        change(subject, "unknown");
        for (const listener of subject.listeners.keys()) notify(listener);
      }
    for (const [key, subject] of selected)
      if (previous.get(key) !== subject)
        for (const listener of subject.listeners.keys()) notify(listener);
    if ([...selected].some(([key, subject]) => previous.get(key) !== subject)) {
      const initial = Math.max(Date.now() + 100, readGate);
      nextRead = previous.size ? Math.min(nextRead, initial) : initial;
    }
    if (!selected.size) {
      nextRead = Infinity;
      controller?.abort();
    }
    schedule();
  }
  let selectionQueued = false;
  function queueDemand() {
    if (selectionQueued || closed) return;
    selectionQueued = true;
    queueMicrotask(() => {
      selectionQueued = false;
      if (!closed) demand();
    });
  }
  async function tick() {
    const now = Date.now();
    for (const subject of selected.values())
      if (subject.expires <= now) change(subject, "unknown");
    if (
      !eligible() ||
      !transport?.presenceSnapshot ||
      reading ||
      now < nextRead ||
      !selected.size
    ) {
      schedule();
      return;
    }
    const captured = new Map(selected);
    const owned = new AbortController();
    controller = owned;
    reading = true;
    readGate = now + 5000;
    nextRead = Infinity;
    schedule();
    try {
      const values = await transport.presenceSnapshot(
        [...captured.keys()],
        owned.signal,
      );
      if (closed || owned.signal.aborted || controller !== owned) return;
      if (values === null)
        readGate = nextRead = Math.max(
          readGate,
          Date.now() + 5000 + Math.random() * 1000,
        );
      else {
        for (const [key, subject] of captured)
          if (subjects.get(key) === subject && selected.get(key) === subject) {
            subject.expires = now + 75000;
            change(
              subject,
              Date.now() < subject.expires
                ? (values.get(key) ?? "unknown")
                : "unknown",
            );
          }
        nextRead = Math.min(nextRead, Date.now() + minute());
      }
    } catch (error) {
      if (closed || owned.signal.aborted || controller !== owned) return;
      for (const subject of captured.values()) change(subject, "unknown");
      const retry =
        error &&
        typeof error === "object" &&
        "retryAfterMs" in error &&
        typeof error.retryAfterMs === "number"
          ? error.retryAfterMs
          : 0;
      readGate = nextRead = Date.now() + Math.max(minute(), retry);
    } finally {
      reading = false;
      if (controller === owned) controller = undefined;
      schedule();
    }
  }
  function clear(publication = true) {
    controller?.abort();
    controller = undefined;
    nextRead = Math.max(Date.now() + 100, readGate);
    if (publication) {
      stopPublishing();
      startPublishing();
    }
    for (const subject of subjects.values()) change(subject, "unknown");
    schedule();
  }
  function stopPublishing() {
    publisher?.abort();
    publisher = undefined;
    clearTimeout(renewal);
    stopPublisher?.();
    stopPublisher = undefined;
  }
  function startPublishing() {
    if (
      publisher ||
      !connected ||
      !transport?.presenceSnapshot ||
      !activity ||
      closed ||
      typeof navigator === "undefined" ||
      !navigator.locks
    )
      return;
    const owned = new AbortController();
    publisher = owned;
    const valid = () =>
      !closed && connected && publisher === owned && !owned.signal.aborted;
    void navigator.locks
      .request(
        `buzz-presence:${transport.scope ?? transport.relayAuthor}:${transport.viewer}`,
        { signal: owned.signal },
        async () => {
          if (!valid()) return;
          await new Promise<void>((resolve) => {
            stopPublisher = resolve;
            const renew = async () => {
              if (!valid()) return;
              try {
                await publish(activity.status(), owned.signal);
              } catch {
                /* Lossy; next renewal owns current state. */
              }
              if (valid()) renewal = setTimeout(() => void renew(), minute());
            };
            renewal = setTimeout(() => void renew(), 250 + Math.random() * 750);
          });
        },
      )
      .catch(() => {})
      .finally(() => {
        if (publisher === owned) publisher = undefined;
      });
  }
  const stopActivity = activity?.subscribe(() => {
    if (!activity.visible()) clear(false);
    else {
      nextRead = Math.min(nextRead, Math.max(Date.now() + 100, readGate));
      schedule();
    }
    if (lastStatus !== activity.status()) {
      lastStatus = activity.status();
      // Replace desired state, not an event backlog. Restarting the lock cancels late signing.
      stopPublishing();
      startPublishing();
    }
  });
  return {
    status(key: string): PresenceStatus {
      return subjects.get(key)?.status ?? "unknown";
    },
    limited: (key: string) => subjects.has(key) && !selected.has(key),
    subscribe(key: string, listener: () => void, profile = false) {
      if (closed || !/^[0-9a-f]{64}$/.test(key)) return () => {};
      let subject = subjects.get(key);
      if (!subject) {
        subject = {
          listeners: new Map(),
          profiles: 0,
          status: "unknown",
          expires: 0,
        };
        subjects.set(key, subject);
      }
      const priority = subject.profiles > 0;
      if (subject.listeners.get(listener)) subject.profiles--;
      if (profile) subject.profiles++;
      subject.listeners.set(listener, profile);
      if (subject.profiles) profiles.set(key, subject);
      else profiles.delete(key);
      if (
        (!selected.has(key) && selected.size < 256) ||
        priority !== subject.profiles > 0
      )
        demand();
      return () => {
        if (subjects.get(key) !== subject || !subject.listeners.has(listener))
          return;
        const priority = subject.profiles > 0;
        if (subject.listeners.get(listener)) subject.profiles--;
        subject.listeners.delete(listener);
        if (!subject.profiles) profiles.delete(key);
        if (!subject.listeners.size) {
          subjects.delete(key);
          selected.delete(key);
        }
        if (!subjects.size) {
          nextRead = Infinity;
          controller?.abort();
          clearTimeout(timer);
        } else if (selected.size < 256 || priority !== subject.profiles > 0)
          queueDemand();
      };
    },
    connected(value: boolean) {
      if (connected === value || closed) return;
      connected = value;
      clear();
    },
    clear,
    dispose() {
      closed = true;
      stopActivity?.();
      stopPublishing();
      clearTimeout(timer);
      controller?.abort();
      subjects.clear();
      profiles.clear();
      selected.clear();
    },
  };
}
export type Presence = ReturnType<typeof createPresence>;
