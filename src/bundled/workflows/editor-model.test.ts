import { expect, test } from "vitest";
import { draftError, exactSaveReadback } from "./editor-model";
import { yamlToFormState } from "./workflowFormTypes";
import {
  createWorkflowFixture,
  fixtureDefinition,
  fixtureYaml,
} from "./fixtures";

test("advanced fields stay raw; opening does not transform source", () => {
  expect(yamlToFormState(fixtureYaml).ok).toBe(true);
  expect(yamlToFormState(`${fixtureYaml}future: retain-me\n`).ok).toBe(false);
  expect(
    yamlToFormState(fixtureYaml.replace("message_posted", "webhook")).ok,
  ).toBe(false);
  expect(
    yamlToFormState(fixtureYaml.replace("    text:", "    if: true\n    text:"))
      .ok,
  ).toBe(false);
  expect(draftError(fixtureYaml)).toBeNull();
  expect(
    draftError(fixtureYaml.replace("text: Hello from a fixture", "text: ''")),
  ).toMatch(/message text/);
});
test("save readback requires operation revision plus owner/channel/id", () => {
  const fixture = createWorkflowFixture();
  const eventId = fixture.capability.save({
    channelId: fixtureDefinition.channelId,
    yaml: fixtureYaml,
    existing: fixtureDefinition,
  });
  fixture.finish("succeeded");
  const operation = fixture.capability.operations.snapshot()[0];
  if (!operation) throw new Error("fixture operation missing");
  const exact = { ...fixtureDefinition, revision: eventId };
  expect(exactSaveReadback(operation, [exact])).toEqual(exact);
  for (const wrong of [
    fixtureDefinition,
    { ...exact, owner: "22".repeat(32) },
    { ...exact, channelId: "other" },
    { ...exact, id: "other" },
  ])
    expect(exactSaveReadback(operation, [wrong])).toBeUndefined();
  expect(
    exactSaveReadback({ ...operation, outcome: "unknown" }, [exact]),
  ).toBeUndefined();
});

test("draft boundaries match signing: UTF-8 bytes, steps and legacy enabled default", () => {
  const pad = `#${"a".repeat(24_000 - new TextEncoder().encode(fixtureYaml).length - 1)}`;
  expect(draftError(fixtureYaml + pad)).toBeNull();
  expect(draftError(`${fixtureYaml}${pad}é`)).toMatch(/24,000 bytes/);
  const steps = (count: number) =>
    "name: bounded\ntrigger: {on: message_posted}\nsteps:\n" +
    Array.from(
      { length: count },
      (_, i) => `  - {id: step_${i}, action: delay, duration: 1s}\n`,
    ).join("");
  expect(draftError(steps(100))).toBeNull();
  expect(draftError(steps(101))).toMatch(/100 steps/);
  expect(draftError(fixtureYaml.replace("enabled: false\n", ""))).toBeNull();
  for (const value of ["null", "'true'", "1"])
    expect(
      draftError(fixtureYaml.replace("enabled: false", `enabled: ${value}`)),
    ).toMatch(/true or false/);
});

test("invalid timeout values block draft submission", () => {
  for (const timeout of [
    "'oops'",
    "'0s'",
    "0",
    "1.5",
    "null",
    "9007199254740992",
  ]) {
    expect(
      draftError(
        fixtureYaml.replace(
          "    text:",
          `    timeout_secs: ${timeout}\n    text:`,
        ),
      ),
    ).toMatch(/timeout.*positive whole number/);
  }
  expect(
    draftError(
      fixtureYaml.replace("    text:", "    timeout_secs: 300\n    text:"),
    ),
  ).toBeNull();
});
