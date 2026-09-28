/** The relay bounds aggregate explicit channel values at 128. */
export const WORKFLOW_CHANNEL_BATCH = 128;
export const WORKFLOW_DEFINITION_LIMIT = 100;

/** Narrow exception to the generic four-filter budget, shared with the broker. */
export function isWorkflowDefinitionBatch(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > WORKFLOW_CHANNEL_BATCH
  )
    return false;
  const channels = new Set<string>();
  return value.every((filter) => {
    if (
      !filter ||
      typeof filter !== "object" ||
      Object.keys(filter).length !== 3 ||
      !Array.isArray(filter.kinds) ||
      filter.kinds.length !== 1 ||
      filter.kinds[0] !== 30620 ||
      !Array.isArray(filter["#h"]) ||
      filter["#h"].length !== 1 ||
      typeof filter["#h"][0] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        filter["#h"][0],
      ) ||
      filter.limit !== WORKFLOW_DEFINITION_LIMIT ||
      channels.has(filter["#h"][0])
    )
      return false;
    channels.add(filter["#h"][0]);
    return true;
  });
}
