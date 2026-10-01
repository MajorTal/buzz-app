import { Link } from "@tanstack/react-router";
import { COMPONENTS } from "../../../../src/shared/design-system/ui/registry";
import { PageHeader } from "./primitives";

export function ComponentsPage() {
  const topLevelComponents = COMPONENTS.filter(
    (component) =>
      component.collection === "components" && component.parent === undefined,
  );

  return (
    <>
      <PageHeader
        title="Components"
        intro="Find a component by its purpose, then explore its examples and states."
      />
      <div className="component-overview-grid">
        {topLevelComponents.map((component) => {
          const children = COMPONENTS.filter(
            (candidate) => candidate.parent === component.slug,
          );
          return (
            <article key={component.slug} className="component-overview-item">
              <Link
                to="/design/components/$component"
                params={{ component: component.slug }}
                className="component-overview-link"
              >
                <h2 className="text-label text-primary">{component.name}</h2>
                <p className="text-body text-secondary">{component.purpose}</p>
              </Link>
              {children.length > 0 ? (
                <nav aria-label={`${component.name} components`}>
                  {children.map((child) => (
                    <Link
                      key={child.slug}
                      to="/design/components/$component"
                      params={{ component: child.slug }}
                      className="text-body-sm text-secondary hover:text-primary"
                    >
                      {child.name}
                    </Link>
                  ))}
                </nav>
              ) : null}
            </article>
          );
        })}
      </div>
    </>
  );
}
