import type { RelaySnapshot } from "../../features/relay/service";
import type { RelayEvent } from "../../features/relay/events";

export const LIVE_ROOM_PREFIX = "Live: ";

export function liveAudioRelayUrl(connection: RelaySnapshot) {
  if (!connection.viewer || !connection.scope)
    throw new Error("Connect to a Buzz community first");
  const suffix = `:${connection.viewer}`;
  if (!connection.scope.endsWith(suffix))
    throw new Error("The current community does not expose Live audio");
  return connection.scope.slice(0, -suffix.length);
}

function endpoint(connection: RelaySnapshot, route: string) {
  return `/api/relay/${encodeURIComponent(liveAudioRelayUrl(connection))}/${route}`;
}

async function post<T>(
  connection: RelaySnapshot,
  route: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(endpoint(connection, route), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as {
      error?: unknown;
    };
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : `Live room request failed (${response.status})`,
    );
  }
  return response.json() as Promise<T>;
}

export function createLiveRoom(
  connection: RelaySnapshot,
  name: string,
  invited: readonly string[] = [],
) {
  return post<{ roomId: string }>(connection, "rooms-create", {
    name,
    invited,
  });
}

export function inviteToLiveRoom(
  connection: RelaySnapshot,
  roomId: string,
  pubkey: string,
) {
  return post<{ accepted: true }>(connection, "rooms-invite", {
    roomId,
    pubkey,
  });
}

export function renameLiveRoom(
  connection: RelaySnapshot,
  roomId: string,
  name: string,
) {
  return post<{ renamed: true }>(connection, "rooms-rename", { roomId, name });
}

export function deleteLiveRoom(connection: RelaySnapshot, roomId: string) {
  return post<{ deleted: true }>(connection, "rooms-delete", { roomId });
}

export function publishLiveRoomPresence(
  connection: RelaySnapshot,
  roomId: string,
  here: boolean,
) {
  return post<{ accepted: true; event: RelayEvent }>(
    connection,
    "rooms-presence",
    { roomId, here },
  );
}

export function startLiveRoomAudio(
  connection: RelaySnapshot,
  parentRoomId: string,
  members: readonly string[],
) {
  return post<{ audioRoomId: string; reused: boolean }>(
    connection,
    "rooms-audio-start",
    { parentRoomId, members, candidates: [] },
  );
}

export function signHuddleChallenge(
  connection: RelaySnapshot,
  challenge: string,
  signal: AbortSignal,
) {
  return post<RelayEvent>(connection, "huddle-auth", { challenge }, signal);
}
