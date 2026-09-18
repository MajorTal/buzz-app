export type MediaTimeAnchor = Readonly<{
  type: "time";
  seconds: number;
}>;

const TIMECODE = /^⏱\s*((?:(\d+):)?(\d{1,2}):(\d{2}))\s+—\s+([\s\S]+)$/;

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
  const match = TIMECODE.exec(content);
  if (!match) return undefined;
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (minutes > 59 && hours > 0) return undefined;
  const value = hours * 3600 + minutes * 60 + seconds;
  const label = match[1];
  const body = match[5];
  if (!label || !body) return undefined;
  return {
    anchor: { type: "time", seconds: value },
    label,
    content: body,
  };
}
