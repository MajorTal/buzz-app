import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import {
  describeValueKind,
  humanizeVariable,
  isHex,
  useResolvedTokens,
} from "../useResolvedToken";
import {
  BACKDROP_CHOICES,
  BACKDROP_TREATMENTS,
  PALETTE,
  RAMPS,
  ROLE_GROUPS,
} from "../../../../src/shared/design-system/tokens/registry";
import { Tabs } from "../../../../src/shared/design-system/ui/Tabs";

import { Note, PageHeader, Section } from "./primitives";

/**
 * Every token in one table: the name you type, the base token it resolves
 * through, and the value it actually paints.
 *
 * The values are read from the live cascade rather than typed into the registry,
 * so this table reports what the product would really render and cannot drift
 * from `tokens.css`. It also means it re-resolves in dark mode, where the same
 * names hold different values — which is the whole point of the role layer.
 */

interface TableRow {
  /** The Tailwind class where one exists, else the custom property. */
  token: string;
  variable: string;
  /** Which layer this row belongs to. */
  layer: "role" | "ramp" | "backdrop" | "choice";
  group: string;
  /** Lifecycle label applies to public roles; raw values have no lifecycle. */
  status?: "core" | "proposed" | "deprecated";
}

function collectRows(): TableRow[] {
  const rows: TableRow[] = [];

  for (const group of ROLE_GROUPS) {
    for (const role of group.roles) {
      rows.push({
        token: role.token,
        variable: role.variable,
        layer: "role",
        group: group.name,
        status: role.status,
      });
    }
  }

  // The palette was missing from this table entirely — 96 steps across eight
  // hues, the layer every role resolves *to*, and the one place a literal
  // lives. `RAMPS` holds only glass, so listing it alone showed five of the
  // hundred-and-one steps that exist.
  for (const hue of PALETTE) {
    for (const step of hue.steps) {
      rows.push({
        token: step.variable.replace(/^--/, ""),
        variable: step.variable,
        layer: "ramp",
        group: hue.usedBy ? `${hue.id} — ${hue.usedBy}` : hue.id,
      });
    }
  }

  for (const ramp of RAMPS) {
    for (const step of ramp.steps) {
      rows.push({
        token: step.variable.replace(/^--/, ""),
        variable: step.variable,
        layer: "ramp",
        group: `${ramp.name} ramp`,
      });
    }
  }

  for (const treatment of BACKDROP_TREATMENTS) {
    rows.push({
      token: treatment.name,
      variable: treatment.variable,
      layer: "backdrop",
      group: `${treatment.mode} backdrop treatments`,
    });
  }

  for (const choice of BACKDROP_CHOICES) {
    rows.push({
      token: choice.token,
      variable: choice.variable,
      layer: "choice",
      group: "Semantic backdrop choices",
    });
  }

  return rows;
}

function ValueSwatch({ value }: { value: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 shrink-0 rounded border border-primary align-middle"
      style={{ background: value }}
    />
  );
}

const VIEWS = [
  { value: "roles", label: "Roles" },
  { value: "choices", label: "Backdrop choices" },
  { value: "ramps", label: "Palette & ramps" },
] as const;

type View = (typeof VIEWS)[number]["value"];

export function ColorTablePage() {
  /* Two tabs rather than two stacked sections. The palette is 96 steps and the
     roles are 55, so one page meant scrolling past a hundred rows to reach the
     other layer — and the ramps were the half nobody could find. Tabs also state
     the distinction the system cares about: what you may type, and what it
     resolves to. */
  const [view, setView] = useState<View>("roles");
  const rows = collectRows();
  const resolved = useResolvedTokens(rows.map((row) => row.variable));

  const roleRows = rows.filter((row) => row.layer === "role");
  const backdropChoiceRows = rows.filter((row) => row.layer === "choice");
  const rampRows = rows.filter(
    (row) => row.layer === "ramp" || row.layer === "backdrop",
  );

  return (
    <>
      <PageHeader
        title="Token table"
        intro="Look up a color token, its source, and the value it renders. Values come from the current CSS and update when you switch appearance."
      />

      <div className="mb-6">
        {/* `panel`, because the /design pages sit on `bg-panel` rather than the
            app gradient. This page is what surfaced the need for the variant:
            the chrome pill's glass container composites to white on a white
            page, and its selected pill is white too. */}
        <Tabs
          value={view}
          items={VIEWS}
          label="Token layer"
          onValueChange={setView}
          variant="panel"
        />
      </div>

      {view === "roles" ? (
        <>
          <Note>
            Build screens with <strong>semantic roles</strong>. Choose the name
            by what the color does, then let the shared palette supply its light
            and dark values. See the{" "}
            <Link to="/design/color" className="text-purple-12 underline">
              Color guide
            </Link>
            .
          </Note>

          <Section
            title="Roles"
            description="Base shows the token a role references. Value shows the final color or treatment in the current mode."
          >
            <TokenTable rows={roleRows} resolved={resolved} showGroups />
          </Section>
        </>
      ) : view === "choices" ? (
        <>
          <Note>
            Each numbered token pairs a light scene with a dark scene:
            <code className="text-mono"> gradient-1 </code> resolves to Sky
            field in light mode and Night garden in dark. Product surfaces keep
            using <code className="text-mono">bg-app</code>; the token mapping
            chooses the treatment for the active mode.
          </Note>

          <Section
            title="Semantic backdrop choices"
            description="Four choices, each with a light and dark treatment. Base shows the treatment active in the current mode."
          >
            <TokenTable
              rows={backdropChoiceRows}
              resolved={resolved}
              showGroups
            />
          </Section>
        </>
      ) : (
        <>
          <Note>
            The palette is where every literal lives, and{" "}
            <code className="text-mono">neutral</code> is a hue like any other.
            It also contains named backdrop treatments: complete, mode-specific
            visual compositions that semantic backdrop choices pair together. A
            component referencing either directly is a bug.
          </Note>

          <Section
            title="Palette values and ramps"
            description="Raw values include twelve steps per hue, named backdrop treatments, and the glass ramp. Their Base cells are empty because they do not reference another token."
          >
            <TokenTable rows={rampRows} resolved={resolved} showGroups />
          </Section>
        </>
      )}
    </>
  );
}

function TokenTable({
  rows,
  resolved,
  showGroups,
}: {
  rows: TableRow[];
  resolved: ReturnType<typeof useResolvedTokens>;
  showGroups?: boolean;
}) {
  let lastGroup: string | null = null;

  return (
    /* Fixed columns keep long gradient values from consuming the table.
       On narrow screens, status shares the token cell instead of competing
       with the swatch for a fourth column. */
    <table className="w-full table-fixed border-collapse text-left">
      <caption className="sr-only">
        Color tokens, their source tokens, and their rendered values
      </caption>
      <colgroup>
        <col className="w-1/3 sm:w-[29%]" />
        <col className="w-1/3 sm:w-[25%]" />
        <col className="hidden sm:table-column sm:w-[16%]" />
        <col className="w-1/3 sm:w-[30%]" />
      </colgroup>
      <thead>
        <tr className="border-primary border-b">
          <th scope="col" className="py-2 pr-4 text-body text-tertiary">
            Token
          </th>
          <th scope="col" className="py-2 pr-4 text-body text-tertiary">
            Base
          </th>
          <th
            scope="col"
            className="hidden py-2 pr-4 text-body text-tertiary sm:table-cell"
          >
            Status
          </th>
          <th scope="col" className="py-2 text-body text-tertiary">
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const token = resolved.get(row.variable);
          const headingRow =
            showGroups && row.group !== lastGroup ? row.group : null;
          lastGroup = row.group;

          return (
            <Fragment key={row.variable}>
              {headingRow ? (
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={4}
                    className="pt-6 pb-1 text-body-sm text-tertiary"
                  >
                    {headingRow}
                  </th>
                </tr>
              ) : null}
              <tr className="border-primary border-b">
                <td className="py-2.5 pr-4 align-top">
                  <code className="break-words text-mono text-primary">
                    {row.token}
                  </code>
                  {row.status ? (
                    <span className="mt-1 block break-words text-body-sm text-secondary sm:hidden">
                      {row.status}
                    </span>
                  ) : null}
                </td>
                <td className="py-2.5 pr-4 align-top">
                  {token?.pointsAtVariable ? (
                    <code className="break-words text-mono text-secondary">
                      {humanizeVariable(token.pointsAtVariable)}
                    </code>
                  ) : (
                    <span className="text-body-sm text-tertiary">—</span>
                  )}
                </td>
                <td className="hidden py-2.5 pr-4 align-top sm:table-cell">
                  <span className="break-words text-body-sm text-secondary">
                    {row.status ?? "—"}
                  </span>
                </td>
                <td className="py-2.5 align-top">
                  <span className="flex min-w-0 items-start gap-2">
                    <span className="mt-0.5 shrink-0">
                      <ValueSwatch value={token?.value ?? "transparent"} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      {/* `break-all`, not `break-words`: a gradient literal is
                            one unbroken token with no spaces to break at, so
                            word-boundary wrapping would overflow the column. */}
                      <code className="break-all text-mono text-secondary">
                        {token?.value ?? "…"}
                      </code>
                      {token && !isHex(token.value) ? (
                        <span className="text-body-sm text-tertiary">
                          {describeValueKind(token.value)}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
