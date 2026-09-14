// Signed imeta is still untrusted. Validate syntax without doing pixel work in
// message folding: at most 9x9 components (166 base83 characters).
const BASE83 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
export function validatedBlurhash(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 6 || value.length > 166)
    return undefined;
  for (const character of value) {
    if (!BASE83.includes(character)) return undefined;
  }
  const size = BASE83.indexOf(value.charAt(0));
  if (size > 80) return undefined;
  const components = ((size % 9) + 1) * (Math.floor(size / 9) + 1);
  return value.length === 4 + 2 * components ? value : undefined;
}
