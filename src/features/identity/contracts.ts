/** Public-only native wire; see docs/identity-security.md. */
export const identityErrors = [
  "invalidInput",
  "invalidConfiguration",
  "unsupportedPlatform",
  "absent",
  "denied",
  "unavailable",
  "corrupt",
  "mismatch",
  "occupied",
  "verificationFailed",
  "cancelled",
  "busy",
] as const;
export type IdentityErrorCode = (typeof identityErrors)[number];
export type LegacyIdentitySource = "buzzDesktopBlob" | "buzzDesktopPerKey";
export type IdentityStatus = Readonly<{
  state: "signedOut" | "ready" | "unavailable";
  pubkey: string | null;
  generation: string;
  revocation: string;
  busy: boolean;
  reason: IdentityErrorCode | null;
}>;
export type UnlockRequest = Readonly<{
  expectedPubkey: string;
  generation: string;
  revocation: string;
}>;
export type ImportRequest = UnlockRequest &
  Readonly<{
    source: LegacyIdentitySource;
    consent: true;
  }>;
export type SignOutRequest = Readonly<{ revocation: string }>;
export interface IdentityBackend {
  status(): Promise<unknown>;
  importLegacy(request: ImportRequest): Promise<unknown>;
  unlockSaved(request: UnlockRequest): Promise<unknown>;
  signOut(request: SignOutRequest): Promise<unknown>;
}
export const identityErrorMessage: Record<IdentityErrorCode, string> = {
  invalidInput:
    "Enter an existing public key (npub or public hex), never a private key. Copying also requires your consent.",
  invalidConfiguration:
    "Secure identity storage is not configured correctly for this app.",
  unsupportedPlatform:
    "Secure identity storage is not supported on this host yet.",
  absent:
    "No identity was found in the selected secure storage. Check the public key and source.",
  denied: "Credential access was denied. Check status before trying again.",
  unavailable:
    "Identity access could not be confirmed. Retry the status check or sign out. A missing reply does not cancel credential access.",
  corrupt:
    "The stored credential could not be read safely. It was not activated.",
  mismatch:
    "The returned identity did not match the selected public key. It was not accepted by this view.",
  occupied:
    "A saved copy already exists. Unlock it instead; copying never overwrites a saved identity.",
  verificationFailed:
    "The saved copy could not be verified. It was not activated.",
  cancelled:
    "This request is no longer current. Check status before choosing another action; it will not be retried automatically.",
  busy: "Secure credential work is still in progress. Sign-out prevents activation but does not dismiss an OS prompt.",
};
export const U64_MAX = 18_446_744_073_709_551_615n;
export function errorCode(value: unknown): IdentityErrorCode {
  const code =
    value && typeof value === "object" && "code" in value ? value.code : null;
  return identityErrors.includes(code as IdentityErrorCode)
    ? (code as IdentityErrorCode)
    : "unavailable";
}
/** Do not retain extra fields or echo malformed IPC values into UI/logs. */
export function parseStatus(value: unknown): IdentityStatus {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw { code: "unavailable" };
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 6 ||
    !["signedOut", "ready", "unavailable"].includes(raw.state as string) ||
    typeof raw.generation !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(raw.generation) ||
    BigInt(raw.generation) > U64_MAX ||
    typeof raw.revocation !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(raw.revocation) ||
    typeof raw.busy !== "boolean" ||
    !(
      raw.reason === null ||
      identityErrors.includes(raw.reason as IdentityErrorCode)
    ) ||
    (raw.state === "ready"
      ? typeof raw.pubkey !== "string" ||
        !/^[0-9a-f]{64}$/.test(raw.pubkey) ||
        raw.reason !== null ||
        raw.busy ||
        BigInt(raw.generation) === U64_MAX
      : raw.pubkey !== null)
  )
    throw { code: "unavailable" };
  return Object.freeze({
    state: raw.state,
    pubkey: raw.pubkey,
    generation: raw.generation,
    revocation: raw.revocation,
    busy: raw.busy,
    reason: raw.reason,
  }) as IdentityStatus;
}
