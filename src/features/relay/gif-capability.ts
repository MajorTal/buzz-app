export type RelayGifSearchInfo = {
  gif?: {
    provider?: string;
    search?: string;
  };
  supported_extensions?: string[];
};

/** Accept only the relay-owned KLIPY route advertised through NIP-11. */
export function relayKlipySearchPath(info: RelayGifSearchInfo): string | null {
  const path = info.gif?.search;
  if (
    info.supported_extensions?.includes("buzz-gif") !== true ||
    info.gif?.provider !== "klipy" ||
    typeof path !== "string" ||
    !/^\/[a-zA-Z0-9/_-]+$/.test(path) ||
    path.includes("//") ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  return path;
}
