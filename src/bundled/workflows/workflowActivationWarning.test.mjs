import assert from "node:assert/strict";
import { test } from "vitest";

import { getWorkflowActivationWarning } from "./workflowActivationWarning.ts";

function workflowYaml(trigger) {
  return `name: Test\ntrigger:\n${trigger}\nsteps:\n  - id: notify\n    action: send_message\n    text: Hi\n`;
}

test("warns when a message trigger matches every message", () => {
  assert.deepEqual(
    getWorkflowActivationWarning(workflowYaml("  on: message_posted")),
    {
      description:
        "It will run for every new message in this channel. Review the trigger before turning it on.",
      title: "This workflow may run often",
    },
  );
});

test("does not warn when a message trigger is narrowed", () => {
  assert.equal(
    getWorkflowActivationWarning(
      workflowYaml('  on: message_posted\n  filter: text == "deploy"'),
    ),
    null,
  );
});

test("warns on schedule activation without interpreting its cadence", () => {
  for (const schedule of [
    "interval: 15m",
    "interval: 2h",
    'cron: "*/5 * * * *"',
    'cron: "0 9 * * *"',
  ]) {
    assert.equal(
      getWorkflowActivationWarning(
        workflowYaml(`  on: schedule\n  ${schedule}`),
      )?.title,
      "Enable this scheduled workflow?",
    );
  }
});

test("returns no warning for malformed or unrelated definitions", () => {
  assert.equal(getWorkflowActivationWarning("not: [valid"), null);
  assert.equal(
    getWorkflowActivationWarning(workflowYaml("  on: reaction_added")),
    null,
  );
});
