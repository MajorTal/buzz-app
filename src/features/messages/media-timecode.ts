export type MediaTimeAnchor = Readonly<{
  type: "time";
  seconds: number;
}>;

const TIMECODE =
  /^\s*⏱\uFE0F?\s*((?:(\d+):)?(\d{1,2}):(\d{2}))\s+—\s*([\s\S]*)$/;

export function formatMediaTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function mediaTimeReply(seconds: number, content: string): string {
  return `⏱ ${formatMediaTime(seconds)} — ${content.trim()}`;
}

export function parseMediaTimeReply(
  content: string,
):
  | Readonly<{ anchor: MediaTimeAnchor; label: string; content: string }>
  | undefined {
  // Accept existing bracketed timestamps as well as time-prefixed replies.
  const legacy =
    /^\s*\[((?:\d+:)?\d{1,2}:\d{2}(?:\.\d{1,3})?)\](?![[(:])\s*([\s\S]*)$/.exec(
      content,
    );
  if (legacy?.[1]) {
    const parts = legacy[1].split(":").map(Number);
    const seconds = parts.at(-1) ?? 0;
    const minutes = parts.at(-2) ?? 0;
    const hours = parts.length === 3 ? (parts[0] ?? 0) : 0;
    const value = hours * 3600 + minutes * 60 + seconds;
    if (
      seconds >= 60 ||
      (parts.length === 3 && minutes >= 60) ||
      !Number.isFinite(value)
    )
      return undefined;
    return {
      anchor: { type: "time", seconds: value },
      label: legacy[1],
      content: legacy[2] ?? "",
    };
  }
  const match = TIMECODE.exec(content);
  if (!match) return undefined;
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (seconds >= 60 || (match[2] !== undefined && minutes >= 60))
    return undefined;
  const value = hours * 3600 + minutes * 60 + seconds;
  const label = match[1];
  const body = match[5];
  if (!label || body === undefined || !Number.isFinite(value)) return undefined;
  return {
    anchor: { type: "time", seconds: value },
    label,
    content: body,
  };
}
