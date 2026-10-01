import { Link } from "@tanstack/react-router";
import { COMPONENTS } from "../../../../src/shared/design-system/ui/registry";
import { BaseUiBackingLine } from "./BaseUiBackingLine";
import { COMPONENT_SPECIMENS } from "./componentSpecimens";
import { MissingPage } from "./MissingPage";
import { PageHeader } from "./primitives";

export function ComponentDetailPage({ slug }: { slug: string }) {
  const component = COMPONENTS.find((candidate) => candidate.slug === slug);
  if (!component) return <MissingPage what="component" />;
  const Specimen = COMPONENT_SPECIMENS[component.slug];

  return (
    <>
      <PageHeader title={component.name} intro={component.purpose}>
        <BaseUiBackingLine slug={component.slug} />
        {[
          "input",
          "textarea",
          "search-field",
          "select",
          "combobox",
          "field",
        ].includes(component.slug) && (
          <p className="text-body-sm text-secondary">
            <Link to="/design/forms">Read the form composition guide →</Link>
          </p>
        )}
      </PageHeader>
      {Specimen ? <Specimen /> : null}
    </>
  );
}
