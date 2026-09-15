import {
  TYPE_FAMILIES,
  TYPE_SOURCE,
  TYPE_RAMPS,
  TYPE_ROLES,
  type TypeRole,
} from "../../../../src/shared/design-system/tokens/registry";

import { Note, PageHeader, Row, Rows, Section, Specimens } from "./primitives";

/**
 * Every specimen below is set in the role it documents, so the page is the
 * system rather than a description of it. A role that reads badly here reads
 * badly in the product.
 */
function RoleSpecimen({ role }: { role: TypeRole }) {
  return (
    <div className="flex flex-col gap-2">
      <p
        className={`${role.token} ${role.mono ? "font-mono" : ""} text-primary`}
      >
        {role.mono ? "createChannel(name, members)" : "Bring your agents in"}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <code className="text-mono text-purple-12">{role.token}</code>
        <span className="text-body-sm text-tertiary">{role.pointsAt}</span>
        <span className="text-body-sm text-tertiary">
          {role.size} / {role.lineHeight} / {role.tracking} / {role.weight}
        </span>
      </div>
      <p className="max-w-xl text-body-sm text-secondary">{role.use}</p>
    </div>
  );
}

export function TypographyPage() {
  return (
    <>
      <PageHeader
        title="Typography"
        intro="Block UI’s 14-step type ramp, rendered in Inter and JetBrains Mono. Buzz utilities map to the resolved Block UI roles below."
      />

      <Section
        title="The faces"
        description="Buzz keeps its existing font families. Sizes, line heights, tracking and weights follow the linked Block UI specification."
      >
        <Specimens>
          {TYPE_FAMILIES.map((family) => (
            <div key={family.token} className="flex flex-col gap-1.5">
              <p
                className={`text-heading text-primary ${
                  family.token === "font-mono" ? "font-mono" : "font-sans"
                }`}
              >
                {family.name}
              </p>
              <code className="text-mono text-purple-12">{family.token}</code>
              <p className="max-w-xl text-body-sm text-secondary">
                {family.use}
              </p>
            </div>
          ))}
        </Specimens>
      </Section>

      <Section
        title="The roles"
        description="Current Buzz utilities and their Block UI role mappings. Each sample uses the role it documents. The three legacy mono utilities now share the same 10/16 detail setting."
      >
        <Specimens>
          {TYPE_ROLES.map((role) => (
            <RoleSpecimen key={role.token} role={role} />
          ))}
        </Specimens>
      </Section>

      {TYPE_RAMPS.map((ramp) => (
        <Section key={ramp.id} title={ramp.name} description={ramp.description}>
          <Rows>
            {ramp.steps.map((step) => (
              <Row key={`${ramp.id}-${step.step}`}>
                <div className="flex flex-wrap items-baseline gap-x-4">
                  <code className="w-28 shrink-0 text-mono text-primary">
                    {ramp.id}.{step.step}
                  </code>
                  <span className="w-20 shrink-0 text-body-sm text-secondary">
                    {step.value}
                  </span>
                  <span className="text-body-sm text-tertiary">{step.job}</span>
                </div>
              </Row>
            ))}
          </Rows>
        </Section>
      ))}

      <Note>
        Source: <a href={TYPE_SOURCE}>Block UI typography resolution</a>{" "}
        (eff76616). The upstream specification is provisional. Buzz keeps
        rem-based scaling and its Inter/JetBrains Mono font bindings; it no
        longer has a separate 11/13/15px monospace scale. Role line heights take
        precedence over the primitive defaults: for example, section titles use
        24/24.
      </Note>
    </>
  );
}
