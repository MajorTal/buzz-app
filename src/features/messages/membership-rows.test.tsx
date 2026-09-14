import { assert, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChannelMessage, MembershipChange } from "../relay/contracts";
import { membershipRows, membershipDescription } from "./membership-rows";
import { MembershipRow } from "./MembershipRow";
import { geometrySignature } from "./geometry";
const wes = "a".repeat(64),
  pinky = "b".repeat(64),
  brain = "c".repeat(64);
const profiles = new Map([
  [wes, { name: "Wes" }],
  [pinky, { name: "Pinky" }],
  [brain, { name: "Brain" }],
]);
function row(
  id: string,
  membership?: MembershipChange,
  createdAt = 100,
): ChannelMessage {
  return {
    id,
    channelId: "a",
    authorId: "relay",
    content: "",
    createdAt,
    ...(membership ? { membership } : {}),
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
  };
}
const joined = (actor: string, target: string): MembershipChange => ({
  type: "member_joined",
  actor,
  target,
});
const left = (target: string): MembershipChange => ({
  type: "member_left",
  actor: target,
  target,
});
const removed = (actor: string, target: string): MembershipChange => ({
  type: "member_removed",
  actor,
  target,
});
it("matches the grouped invitation wording and keeps pronouns grammatical", () => {
  expect(
    membershipDescription(
      [row("1", joined(wes, pinky)), row("2", joined(wes, brain))],
      profiles,
      wes,
    ).text,
  ).toBe("Pinky added by you, along with Brain");
  expect(
    membershipDescription([row("1", joined(pinky, wes))], profiles, wes).text,
  ).toBe("You were added by Pinky");
  expect(
    membershipDescription(
      [row("1", joined(pinky, pinky)), row("2", joined(brain, brain))],
      profiles,
      wes,
    ).text,
  ).toBe("Pinky joined along with Brain");
  expect(
    membershipDescription(
      [row("1", joined(wes, pinky)), row("2", joined(brain, brain))],
      profiles,
      wes,
    ).text,
  ).toBe("Pinky arrived along with Brain");
  expect(
    membershipDescription([row("1", removed(pinky, wes))], profiles, wes).text,
  ).toBe("You were removed by Pinky");
});
it("groups departures/removals without attributing a removal to the wrong actor", () => {
  const rows = [
    row("1", left(pinky)),
    row("2", left(brain)),
    row("3", removed(wes, pinky)),
    row("4", removed(brain, wes)),
  ];
  expect(membershipRows(rows).map((r) => r.id)).toEqual(["2", "3", "4"]);
  expect(membershipDescription(rows.slice(0, 2), profiles).text).toBe(
    "Pinky, along with Brain, left the channel",
  );
});
it("messages, day boundaries and one-hour gaps break groups; older pages keep existing keys", () => {
  const a = row("a", joined(wes, pinky), 200),
    b = row("b", joined(wes, brain), 210);
  expect(membershipRows([a, b]).map((r) => r.id)).toEqual(["b"]);
  const old = row("old", joined(pinky, pinky), 100);
  expect(membershipRows([old, a, b]).map((r) => r.id)).toEqual(["b"]);
  expect(membershipRows([a, row("chat"), b])).toHaveLength(3);
  expect(
    membershipRows([a, { ...b, createdAt: a.createdAt + 3601 }]),
  ).toHaveLength(2);
  expect(
    membershipRows([a, { ...b, createdAt: a.createdAt + 3600 }]),
  ).toHaveLength(1);
  const midnight = new Date(2026, 8, 12).getTime() / 1000;
  expect(
    membershipRows([
      { ...a, createdAt: midnight - 1 },
      { ...b, createdAt: midnight },
    ]),
  ).toHaveLength(2);
});
it("repeated self-joins followed by departure preserve the complete lifecycle", () => {
  const rows = [
    row("1", joined(pinky, pinky)),
    row("2", joined(pinky, pinky)),
    row("3", left(pinky)),
  ];
  const grouped = membershipRows(rows);
  expect(grouped).toHaveLength(1);
  expect(grouped[0]?.membershipRows).toEqual(rows);
  expect(membershipDescription(rows, profiles).text).toBe(
    "Pinky joined and left the channel",
  );
  // An addition is not a self-join; a departure must remain visible separately.
  expect(
    membershipRows([row("1", joined(wes, pinky)), row("2", left(pinky))]),
  ).toHaveLength(2);
});
it("every grouped input remains represented for mixed three-event sequences", () => {
  const changes = [
    joined(wes, pinky),
    joined(pinky, pinky),
    joined(brain, brain),
    joined(brain, pinky),
    left(pinky),
    left(brain),
    removed(wes, pinky),
    removed(brain, pinky),
  ];
  for (const a of changes)
    for (const b of changes)
      for (const c of changes) {
        const rows = [row("a", a), row("b", b), row("c", c)];
        const groups = membershipRows(rows);
        expect(groups.flatMap((r) => r.membershipRows ?? [r])).toEqual(rows);
        for (const group of groups) {
          const description = membershipDescription(
            group.membershipRows ?? [group],
            profiles,
          );
          expect(description.text).not.toBe("");
          expect(description.targets).toEqual([
            ...new Set(
              (group.membershipRows ?? [group]).map(
                (r) => r.membership?.target,
              ),
            ),
          ]);
        }
      }
});
it("caps visible names/avatars with an overflow count, retaining all names in the title", () => {
  const rows = [pinky, brain, wes, "d".repeat(64)].map((id, i) =>
    row(String(i), joined(id, id)),
  );
  const group = membershipRows(rows)[0];
  assert.exists(group);
  const html = renderToStaticMarkup(
    <MembershipRow
      row={group}
      profiles={profiles}
      media={() => undefined}
      viewer={wes}
      day={false}
    />,
  );
  expect(html).toContain("Pinky joined along with Brain, you, and 1 other");
  expect(html).toContain("+1");
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain("button");
  expect(html).not.toContain("relay");
  expect(html).toContain("data-membership-row");
  expect(html).toContain("dddddddddd");
});
it("actor/subject profile enrichment invalidates cached system-row geometry", () => {
  const rows = [row("a", joined(wes, pinky))];
  const original = geometrySignature(rows, profiles);
  expect(
    geometrySignature(
      rows,
      new Map([...profiles, [pinky, { name: "Longer Pinky" }]]),
    ),
  ).not.toBe(original);
  expect(
    geometrySignature(
      rows,
      new Map([...profiles, [wes, { name: "Longer Wes" }]]),
    ),
  ).not.toBe(original);
});
