import type { ReactNode } from "react";
import { Section } from "./primitives";

// An intent crosswalk, not another token inventory. Values remain owned by the
// shared styles and registry. Reference metrics are a snapshot, not Buzz defaults.
const RULES = [
  {
    title: "Color",
    rows: [
      [
        "Reading hierarchy",
        "Primary content, supporting copy, metadata",
        "text-primary / text-secondary / text-tertiary",
        "Already expressed. Keep three levels.",
      ],
      [
        "Surface hierarchy",
        "Choose the surface by its role",
        "bg-panel / bg-float; shared Panel",
        "Keep Buzz’s light/dark pairs and component ownership.",
      ],
      [
        "Status",
        "Color communicates an actual outcome",
        "text-green-12 with a check and “Complete”",
        "Try the existing green ramp. No new success alias yet.",
      ],
      [
        "Boundaries",
        "Use separation appropriate to the content",
        "border-primary",
        "Keep the shared divider; do not import extra border weights.",
      ],
    ],
  },
  {
    title: "Typography",
    rows: [
      [
        "Screen identity",
        "page-title",
        "text-title",
        "Map intent; retain Buzz’s current metrics.",
      ],
      [
        "Content group",
        "section-title",
        "text-heading",
        "Keep 16px-equivalent / 600 structure.",
      ],
      [
        "Reading text",
        "body-medium; reference default 16px",
        "text-body → text-body-lg in the reading paragraph",
        "Compare 14 with 16px-equivalent locally, not a global body change.",
      ],
      [
        "Control labels",
        "label-medium / label-small",
        "Shared component type; text-body / text-body-sm in compositions",
        "Keep component-owned labels. Add a role only if a repeated need emerges.",
      ],
      [
        "Supporting detail",
        "caption",
        "text-body-sm",
        "Keep the 12px-equivalent sans floor.",
      ],
      [
        "Weight",
        "Regular / Medium (400 / 500)",
        "Content / structure (400 / 600)",
        "Retain Buzz’s deliberate weight distinction in this pass.",
      ],
      [
        "Numbers and micro data",
        "Dedicated numeral and monospace roles",
        "Existing mono roles where appropriate",
        "Defer additional roles until a real product surface needs them.",
      ],
    ],
  },
  {
    title: "Spacing",
    rows: [
      [
        "Fine spacing",
        "8px-based layout rhythm",
        "space-1…6: 4 / 8 / 12 / 16 / 20 / 24px-equivalent",
        "Keep the fine steps for dense controls and rows.",
      ],
      [
        "Panel inset",
        "Context-dependent container spacing",
        "space-panel-inset: 20px-equivalent",
        "Keep the existing inset to isolate the section-gap comparison.",
      ],
      [
        "Content groups",
        "Larger gaps distinguish larger groups",
        "space-section-gap → twice that gap",
        "Try 16 → 32px-equivalent between groups. A Buzz proposal, not an exact BlockUI mapping.",
      ],
      [
        "Page rhythm",
        "Reference observations include 32px title/content and 64px section gaps",
        "Choose relationships for the actual Buzz surface",
        "Defer page-scale changes; do not apply those distances to every control.",
      ],
    ],
  },
] as const;

function RuleTable({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className="alignment-table-wrap"
      aria-label={`${title} mapping`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow region must be keyboard-scrollable on narrow screens.
      tabIndex={0}
    >
      <table className="alignment-table text-body-sm">
        <caption className="sr-only">
          {title}: reference intent, Buzz mapping, and first-pass decision
        </caption>
        <thead>
          <tr>
            <th scope="col">Use case</th>
            <th scope="col">BlockUI reference</th>
            <th scope="col">Buzz mapping</th>
            <th scope="col">First pass</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </section>
  );
}

/** Flat, explicit mappings keep proposals distinct from the system's rules. */
export function AlignmentRules() {
  return (
    <>
      {RULES.map(({ title, rows }) => (
        <Section key={title} title={title}>
          <RuleTable title={title}>
            {rows.map(([use, reference, mapping, decision]) => (
              <tr key={use}>
                <th scope="row">{use}</th>
                <td>{reference}</td>
                <td>{mapping}</td>
                <td>{decision}</td>
              </tr>
            ))}
          </RuleTable>
        </Section>
      ))}
      <Section title="Next decision">
        <p className="text-body text-secondary">
          Choose the useful changes, try them on a real product surface, then
          promote repeated decisions into shared tokens. This proposal adds no
          global tokens, component variants, or theme controls.
        </p>
        <p className="text-body-sm text-secondary">
          Reference: BlockUI’s September 2026 specification snapshot. Some
          reference metrics remain provisional. The examples use Inter and
          Tabler; no proprietary fonts, icons, or implementation are included.
        </p>
      </Section>
    </>
  );
}
