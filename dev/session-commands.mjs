import { sessionMetadata } from "../src/features/sessions/metadata.ts";
// Host signing allowlist. No arbitrary kinds, roles or metadata edits.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validSessionCommand(event) {
  if (
    !event ||
    !Number.isSafeInteger(event.created_at) ||
    !Array.isArray(event.tags) ||
    typeof event.content !== "string"
  )
    return false;
  if (
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((value) => typeof value === "string"),
    )
  )
    return false;
  let tags = event.tags;
  if ([9000, 9007].includes(event.kind) && tags.at(-1)?.[0] === "client-id") {
    const clientId = tags.at(-1);
    if (clientId.length !== 2 || !uuid.test(clientId[1])) return false;
    tags = tags.slice(0, -1);
  }
  const [h, p] = tags;
  if (h?.length !== 2 || h[0] !== "h" || !uuid.test(h[1])) return false;
  if (event.kind === 9007) {
    const expected = ["h", "name", "visibility", "channel_type", "about"];
    return (
      event.content === "" &&
      tags.length === expected.length &&
      tags.every(
        (tag, index) => tag.length === 2 && tag[0] === expected[index],
      ) &&
      !!tags[1][1].trim() &&
      [...tags[1][1]].length <= 120 &&
      tags[2][1] === "private" &&
      tags[3][1] === "stream" &&
      sessionMetadata(tags[4][1]) !== undefined
    );
  }
  if (event.kind === 9000)
    return (
      event.content === "" &&
      tags.length === 2 &&
      p?.length === 2 &&
      p[0] === "p" &&
      /^[0-9a-f]{64}$/.test(p[1])
    );
  return false;
}
