/** Host-projected telemetry. Never a signed RelayEvent or a general decrypt API. */
export const OBSERVER_KIND = 24200;
export const OBSERVER_PLAINTEXT_BYTES = 65535;
export type ObserverFrame = Readonly<{
  id: string;
  agent: string;
  createdAt: number;
  plaintext: string;
}>;
export function observerFrame(value: unknown): ObserverFrame {
  const frame = value as ObserverFrame | null;
  if (
    !frame ||
    typeof frame !== "object" ||
    Array.isArray(frame) ||
    typeof frame.id !== "string" ||
    typeof frame.agent !== "string" ||
    !/^[0-9a-f]{64}$/.test(frame.id) ||
    !/^[0-9a-f]{64}$/.test(frame.agent) ||
    !Number.isSafeInteger(frame.createdAt) ||
    frame.createdAt < 0 ||
    typeof frame.plaintext !== "string" ||
    new TextEncoder().encode(frame.plaintext).length > OBSERVER_PLAINTEXT_BYTES
  )
    throw new Error("Invalid observer frame");
  // Validate JSON here; unknown fields and event kinds remain inert raw evidence.
  JSON.parse(frame.plaintext);
  return Object.freeze({
    id: frame.id,
    agent: frame.agent,
    createdAt: frame.createdAt,
    plaintext: frame.plaintext,
  });
}
export function observerGeneration(value: unknown): number | null {
  if (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  )
    return value;
  throw new Error("Invalid observer generation");
}
