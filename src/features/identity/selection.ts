import { nip19 } from "nostr-tools";

/** Public input only. Hex cannot distinguish a public key from a mistaken secret. */
export function publicKey(input: string): string {
  const value = input.trim();
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  if (value.startsWith("npub1") && value.length <= 128) {
    try {
      const decoded = nip19.decode(value);
      if (decoded.type === "npub") return decoded.data;
    } catch {
      /* Never echo possibly secret input. */
    }
  }
  throw { code: "invalidInput" };
}
export const SELECTION_KEY = "buzz-identity-selection.v1";
export type SelectionStorage = Pick<Storage, "getItem" | "setItem">;
export function browserSelectionStorage(): SelectionStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
export function readSelection(storage?: SelectionStorage): string {
  try {
    return publicKey(storage?.getItem(SELECTION_KEY) ?? "");
  } catch {
    return "";
  }
}
