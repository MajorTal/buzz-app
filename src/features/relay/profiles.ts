import { newer } from "./events";
import type { EventData } from "./events";
import type { Profile } from "./contracts";

/** Kind 0 metadata. Only the author's own latest event counts. */
export function foldProfiles(
  events: readonly EventData[],
): Map<string, Profile> {
  const latest = new Map<string, EventData>();
  for (const event of events) {
    if (event.kind !== 0) continue;
    const previous = latest.get(event.pubkey);
    latest.set(event.pubkey, newer(previous, event));
  }
  const profiles = new Map<string, Profile>();
  for (const [pubkey, event] of latest) {
    try {
      const body = JSON.parse(event.content) as {
        display_name?: unknown;
        name?: unknown;
        picture?: unknown;
        about?: unknown;
        is_agent?: unknown;
        isAgent?: unknown;
      };
      const name = [body.display_name, body.name].find(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
      const picture =
        typeof body.picture === "string" && /^https:\/\//.test(body.picture)
          ? body.picture
          : undefined;
      profiles.set(
        pubkey,
        Object.freeze({
          name: name ?? pubkey.slice(0, 10),
          ...(picture ? { picture } : {}),
          ...(typeof body.about === "string" && body.about.trim()
            ? { about: body.about.trim() }
            : {}),
          ...(body.is_agent === true || body.isAgent === true
            ? { isAgent: true as const }
            : {}),
        }),
      );
    } catch {
      profiles.set(pubkey, Object.freeze({ name: pubkey.slice(0, 10) }));
    }
  }
  return profiles;
}
