// Adapted from block/buzz desktop workflow helpers at b9392d9d.
const DURATION_PARTS_PATTERN =
  /^\s*(?:(\d+)\s*w)?\s*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?\s*$/i;

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK = 7 * SECONDS_PER_DAY;

/** Parse compact durations such as `5s`, `1h 2s`, `2d`, or `3w`. */
export function parseDurationSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  const match = DURATION_PARTS_PATTERN.exec(trimmed);
  if (!match || match.slice(1).every((part) => part === undefined)) return null;

  const weeks = Number(match[1] ?? 0);
  const days = Number(match[2] ?? 0);
  const hours = Number(match[3] ?? 0);
  const minutes = Number(match[4] ?? 0);
  const seconds = Number(match[5] ?? 0);
  const total =
    weeks * SECONDS_PER_WEEK +
    days * SECONDS_PER_DAY +
    hours * SECONDS_PER_HOUR +
    minutes * SECONDS_PER_MINUTE +
    seconds;

  return Number.isSafeInteger(total) ? total : null;
}

/** Format whole seconds as a compact duration, omitting empty units. */
export function formatDurationSeconds(totalSeconds: number): string {
  if (!Number.isSafeInteger(totalSeconds) || totalSeconds < 0) return "";
  if (totalSeconds === 0) return "0s";

  const weeks = Math.floor(totalSeconds / SECONDS_PER_WEEK);
  const days = Math.floor((totalSeconds % SECONDS_PER_WEEK) / SECONDS_PER_DAY);
  const hours = Math.floor((totalSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  const minutes = Math.floor(
    (totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE,
  );
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const parts: string[] = [];

  if (weeks > 0) parts.push(`${weeks}w`);
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}
