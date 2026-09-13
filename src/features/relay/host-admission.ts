import { createLiveAdmission } from "./live.ts";
import { createApiAdmission } from "./http-admission.ts";

/** In-memory host ownership, not a cross-app quota promise. Capacity eviction may
 * forget idle pacing history but never an active stream, queued work or cooldown. */
export function createHostAdmission() {
  const principals = new Map<
    string,
    {
      live: ReturnType<typeof createLiveAdmission>;
      api: ReturnType<typeof createApiAdmission>;
      streams: number;
    }
  >();
  return (endpoint: string, viewer: string) => {
    const key = JSON.stringify([endpoint, viewer]);
    let principal = principals.get(key);
    if (!principal) {
      for (const [id, entry] of principals)
        if (!entry.streams && entry.api.idle() && entry.live.idle())
          principals.delete(id);
      if (principals.size >= 64)
        throw new Error("Relay admission owner capacity reached");
      principal = {
        live: createLiveAdmission(),
        api: createApiAdmission(),
        streams: 0,
      };
      principals.set(key, principal);
    }
    return principal;
  };
}
