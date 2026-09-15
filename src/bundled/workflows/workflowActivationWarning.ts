import { parse as yamlParse } from "yaml";

/** Warn on activation; schedule interpretation and execution belong to the relay. */
export function getWorkflowActivationWarning(
  yaml: string,
): { title: string; description: string } | null {
  try {
    const trigger = yamlParse(yaml)?.trigger;
    if (
      trigger?.on === "message_posted" &&
      !(typeof trigger.filter === "string" && trigger.filter.trim())
    ) {
      return {
        title: "This workflow may run often",
        description:
          "It will run for every new message in this channel. Review the trigger before turning it on.",
      };
    }
    if (trigger?.on === "schedule") {
      return {
        title: "Enable this scheduled workflow?",
        description:
          "The relay may run this workflow automatically on its configured schedule. Review the schedule in YAML before turning it on.",
      };
    }
  } catch {
    // Draft validation reports malformed YAML; it cannot be saved.
  }
  return null;
}
