import { RADII } from "../../../../src/shared/design-system/tokens/registry";
import { FoundationScale } from "./FoundationScale";
import { PageHeader, Section } from "./primitives";

export function RadiusPage() {
  return (
    <>
      <PageHeader
        title="Radius"
        status="forming"
        intro="Choose corners by purpose: rows, fields, panels, text buttons, or fully rounded controls. Keep the shared role with the component so its states retain the same shape."
      />

      <Section title="Roles">
        <FoundationScale
          items={RADII.map((item) => ({
            token: item.token,
            value: item.value,
            use: item.use,
          }))}
        />
      </Section>

      <Section title="Relationship">
        <div className="component-radius-demo bg-app">
          {RADII.map((item) => (
            <div
              key={item.token}
              className="component-radius-sample bg-panel text-body-sm text-secondary"
              style={{ borderRadius: `var(${item.variable})` }}
            >
              {item.token}
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
