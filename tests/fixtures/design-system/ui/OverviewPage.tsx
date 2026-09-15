import { Link } from "@tanstack/react-router";

import { GRAMMAR } from "../../../../src/shared/design-system/tokens/registry";

import { PageHeader, Section } from "./primitives";

const LAYERS: Array<[string, string, string]> = [
  [
    "Palette",
    "--purple-1…12, --neutral-1…12",
    "public, authored in both modes",
  ],
  [
    "Roles",
    "--bg-panel, --text-primary",
    "names for decisions a step cannot express",
  ],
  ["Components", "Button, Panel, Tabs", "shared appearance and interaction"],
];

export function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Buzz Design System"
        intro="Shared foundations and components for the interface. Tokens define color, typography, spacing and materials; components combine them with consistent interaction and accessibility."
      />

      <Section
        title="The layers"
        description="Use the authored ramps directly, or a semantic role when the decision needs one. Glass is available only as a complete material."
      >
        <div className="flex flex-col gap-2 rounded-xl bg-neutral-2 px-6 py-5">
          {LAYERS.map(([layer, what, why]) => (
            <div key={layer} className="flex flex-wrap items-baseline gap-x-4">
              <span className="w-16 shrink-0 text-body text-tertiary">
                {layer}
              </span>
              <code className="min-w-0 flex-1 text-body-sm text-primary">
                {what}
              </code>
              <span className="text-body-sm text-secondary">{why}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="The grammar">
        <div className="rounded-lg bg-neutral-11 px-5 py-4">
          <code className="text-body text-neutral-1">{GRAMMAR}</code>
        </div>
        <p className="text-body-sm text-secondary">
          The order is fixed, so there is one correct spelling. The practical
          guidance for using and evolving it lives in{" "}
          <Link to="/design/maintaining" className="text-purple-12 underline">
            Maintaining the system
          </Link>
          .
        </p>
      </Section>

      <Section
        title="Explore the system"
        description="Foundations document the available tokens and their use. Component pages show live examples, variants and interaction states. Layout playgrounds contain experimental compositions."
      >
        <div className="flex flex-wrap gap-2">
          <Link
            to="/design/color"
            className="rounded-lg bg-purple-9 px-4 py-2 text-body text-on-accent transition-opacity hover:opacity-90"
          >
            Color
          </Link>
          <Link
            to="/design/typography"
            className="rounded-lg bg-neutral-2 px-4 py-2 text-body text-secondary transition-colors hover:bg-neutral-4 hover:text-primary"
          >
            Typography
          </Link>
          <Link
            to="/design/glass"
            className="rounded-lg bg-neutral-2 px-4 py-2 text-body text-secondary transition-colors hover:bg-neutral-4 hover:text-primary"
          >
            Glass
          </Link>
          <Link
            to="/design/maintaining"
            className="rounded-lg bg-neutral-2 px-4 py-2 text-body text-secondary transition-colors hover:bg-neutral-4 hover:text-primary"
          >
            Maintaining the system
          </Link>
        </div>
      </Section>
    </>
  );
}
