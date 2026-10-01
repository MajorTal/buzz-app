import { MOTION } from "../../../../src/shared/design-system/tokens/registry";
import { FoundationScale } from "./FoundationScale";
import { PageHeader, Section } from "./primitives";

export function MotionPage() {
  return (
    <>
      <PageHeader
        title="Motion"
        status="forming"
        intro="Use motion to explain a change in state or position. Controls respond quickly; dragged panels follow the pointer exactly and settle after release."
      />

      <Section title="Roles">
        <FoundationScale
          items={MOTION.map((item) => ({
            token: item.token,
            value: item.value,
            use: item.use,
          }))}
        />
      </Section>

      <Section
        title="Rules"
        description="Use shared timing and curves, preserve immediate direct manipulation, and respect reduced motion."
      >
        <ul className="flex list-disc flex-col gap-2 pl-5">
          {[
            "Direct manipulation follows the pointer exactly. Easing begins only after release.",
            "Avoid animating blur. The design guide records narrow exceptions for shared popups and tooltips; glass transitions use opacity.",
            "Reduced motion removes movement without changing state. Follow each component’s documented treatment; tooltips retain a fade.",
            "Motion explains selection, entry, exit, or changed geometry; it never decorates still content.",
          ].map((rule) => (
            <li key={rule} className="text-body text-secondary">
              {rule}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
