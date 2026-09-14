import { IconMoon, IconSun } from "@tabler/icons-react";
import { Link, Outlet } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";

import { useColorScheme } from "../../../../src/shared/design-system/theme/useColorScheme";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import { COMPONENTS } from "../../../../src/shared/design-system/ui/registry";

type NavItem = [label: string, to: string, children?: NavItem[]];

type NavSection = { heading: string; items: NavItem[] };

function componentNavItems(
  collection: "components" | "product-ui",
  parent?: string,
): NavItem[] {
  return COMPONENTS.filter(
    (component) =>
      component.collection === collection && component.parent === parent,
  ).map((component) => [
    component.name,
    `/design/components/${component.slug}`,
    componentNavItems(collection, component.slug),
  ]);
}

const SECTIONS: NavSection[] = [
  {
    heading: "Foundations",
    items: [
      ["Color", "/design/color", [["Token table", "/design/color/table"]]],
      ["Typography", "/design/typography"],
      ["Spacing", "/design/spacing"],
      ["Radius", "/design/radius"],
      ["Elevation", "/design/elevation"],
      ["Glass", "/design/glass"],
      ["Motion", "/design/motion"],
      ["Base UI backing", "/design/components/base-ui"],
    ],
  },
  {
    heading: "System",
    items: [
      ["DESIGN.md", "/design/design-guide"],
      ["AGENTS.md", "/design/agents-guide"],
    ],
  },
  {
    heading: "Components",
    items: [
      ["Overview", "/design/components", componentNavItems("components")],
    ],
  },
  {
    heading: "Layout playgrounds",
    items: componentNavItems("product-ui"),
  },
];

function NavLink({
  to,
  exact,
  children,
}: {
  to: string;
  exact?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      {...(exact ? { activeOptions: { exact: true } } : {})}
      className="design-system-nav-link text-body text-primary"
      activeProps={{
        className:
          "design-system-nav-link design-system-nav-link-active text-body text-primary",
      }}
    >
      {children}
    </Link>
  );
}

function NavItems({ items, depth = 0 }: { items: NavItem[]; depth?: number }) {
  return (
    <div className="design-system-nav-items">
      {items.map(([label, to, children]) => (
        <Fragment key={to}>
          <div className={depth ? "design-system-nav-child" : undefined}>
            <NavLink
              to={to}
              exact={children !== undefined && children.length > 0}
            >
              {label}
            </NavLink>
          </div>
          {children?.length ? (
            <NavItems items={children} depth={depth + 1} />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

/** `children` is for the not-found shell, which renders outside the route tree. */
export function DesignSystemLayout({ children }: { children?: ReactNode }) {
  const { scheme, toggle, persistenceError } = useColorScheme();

  return (
    <div className="design-system-shell">
      <nav aria-label="Design system" className="design-system-nav">
        <Link
          to="/design"
          className="design-system-nav-title design-system-nav-link text-body text-primary"
        >
          Buzz Design System
        </Link>
        <div aria-hidden="true" className="design-system-nav-rule" />
        <div className="design-system-nav-sections">
          {SECTIONS.map((section) => (
            <section
              className="design-system-nav-section"
              key={section.heading}
            >
              <h2 className="text-body text-tertiary">{section.heading}</h2>
              <NavItems items={section.items} />
            </section>
          ))}
        </div>
      </nav>
      <main className="design-system-content">
        <IconButton
          aria-label={scheme === "dark" ? "Use light mode" : "Use dark mode"}
          icon={
            scheme === "dark" ? (
              <IconSun size={16} aria-hidden="true" />
            ) : (
              <IconMoon size={16} aria-hidden="true" />
            )
          }
          size="toolbar"
          onClick={toggle}
        />
        <div className="design-system-reading-column">
          {persistenceError ? (
            <p role="status" className="text-body text-secondary">
              Appearance is temporary because browser storage is unavailable.
              Toggle again to retry saving.
            </p>
          ) : null}
          {children ?? <Outlet />}
        </div>
      </main>
    </div>
  );
}
