import { registerBrokerCommunity } from "../relay/transport";
import { nativeIdentityEnabled } from "../identity/service";
import { nativeRelayInfo } from "../relay/native";

/** Keep untrusted relay metadata out of executable URL schemes and huge data URLs. */
export function communityIcon(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= 2048) {
    try {
      // Parse authority instead of rejecting '@' in legitimate paths or queries.
      const url = new URL(value);
      if (
        /^https:\/\//i.test(value) &&
        url.protocol === "https:" &&
        url.hostname &&
        !url.username &&
        !url.password &&
        !/\s/.test(value)
      )
        return value;
    } catch {
      // Not a valid URL; it may still be a supported inline raster image.
    }
  }
  if (value.length <= 98_304 && value.startsWith("data:image/svg+xml,")) {
    try {
      // Buzz emoji avatars use this fixed template. Rebuild it instead of trusting
      // arbitrary SVG from relay metadata (scripts, foreignObject, remote loads).
      const svg = decodeURIComponent(value.slice("data:image/svg+xml,".length));
      const match =
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="(112|256)" fill="(#[0-9a-fA-F]{6})"\/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">((?:[^<>&]|&(?:amp|lt|gt);){1,128})<\/text><\/svg>$/.exec(
          svg,
        );
      if (match) {
        const [, radius, color, text] = match;
        return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="${radius}" fill="${color}"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">${text}</text></svg>`)}`;
      }
    } catch {
      return undefined;
    }
  }
  if (
    value.length <= 98_304 &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value)
  )
    return value;
  return undefined;
}

/** NIP-11 icon comes through the existing same-origin broker, without a relay session. */
export async function fetchCommunityIcon(id: string, signal: AbortSignal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  if (nativeIdentityEnabled())
    return communityIcon((await nativeRelayInfo(id, bounded)).icon);
  await registerBrokerCommunity(id, bounded);
  const response = await fetch(
    `/api/relay/${encodeURIComponent(id)}/icon-info`,
    {
      credentials: "same-origin",
      signal: bounded,
    },
  );
  if (!response.ok) return undefined;
  const info: unknown = await response.json();
  return info && typeof info === "object" && "icon" in info
    ? communityIcon(info.icon)
    : undefined;
}
