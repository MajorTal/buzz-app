import { expect, it } from "vitest";
import { mentionQuery, matchesMentionQuery } from "./mention-query";
import { mentionConformance } from "./mention-rules.conformance";

it("opens at word/open-bracket boundaries without treating email/URLs as mentions", () => {
  for (const text of ["@", "hi @Ho", "(@Ho", "[@Ho", "{@Ho", "\n@Ho"]) {
    expect(mentionQuery(text, text.length)?.start).toBe(text.lastIndexOf("@"));
  }
  for (const text of [
    "a@host.test",
    "https://host/@ho",
    "text@ho",
    "@ho\nmore",
  ]) {
    expect(mentionQuery(text, text.length)).toBeNull();
  }
});
it("uses UTF-16 ranges at the actual caret and respects the scan bound", () => {
  expect(mentionQuery("🧠 @Ho tail", 7)).toEqual({
    start: 3,
    end: 7,
    query: "Ho ",
  });
  expect(mentionQuery(`a@${"x".repeat(159)}`, 161)).toBeNull();
  expect(mentionQuery("@name", -1)).toBeNull();
});
it("only continues spaces for known multi-word names; completion does not bind identity", () => {
  expect(matchesMentionQuery("Princess D", ["Princess Donut"])).toBe(true);
  expect(matchesMentionQuery("Honey prose", ["Honey"])).toBe(false);
  expect(matchesMentionQuery("Honey ", ["Honey", "Honey Bee"])).toBe(false);
  expect(matchesMentionQuery("Unknown", [])).toBe(true);
});

it.each(mentionConformance.query)(
  "conforms to the portable query contract: $name",
  (fixture) => {
    expect(mentionQuery(fixture.text, fixture.caret)).toEqual(fixture.expected);
  },
);
it.each(mentionConformance.admission)(
  "conforms to the portable multi-word admission contract: $name",
  (fixture) => {
    expect(matchesMentionQuery(fixture.query, fixture.names)).toBe(
      fixture.expected,
    );
  },
);
