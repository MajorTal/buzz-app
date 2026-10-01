import {
  SPACE,
  SPACE_ROLES,
} from "../../../../src/shared/design-system/tokens/registry";
import { FoundationScale } from "./FoundationScale";
import { PageHeader, Section } from "./primitives";
import { Link } from "@tanstack/react-router";

export function SpacingPage() {
  return (
    <>
      <PageHeader
        title="Spacing"
        status="forming"
        intro="Use the spacing scale for consistent insets and gaps. Named roles describe recurring relationships, from controls within a row to sections on a page."
      />

      <Section
        title="Scale"
        description="Use a named spacing role when it describes the relationship. Add a role only when a real component needs it."
      >
        <FoundationScale
          items={SPACE.map((item) => ({
            token: `space ${item.step}`,
            value: item.value,
            use: item.use,
          }))}
        />
      </Section>

      <Section
        title="Implementation rule: align row content"
        description="Align a dialog's heading with the leading content column of its rows. Let hover and selection backgrounds extend around that content."
      >
        <p className="max-w-2xl text-body text-secondary">
          Keep NavigationItem padding intact and offset the list wrapper using
          the control-inset token. Use equal icon slots, preserve an 8px outer
          gutter on compact dialogs, and leave room for keyboard focus inside
          scrollable lists. Empty states follow the same content edge.
        </p>
        <Link to="/design/design-guide" className="text-body underline">
          Read the row alignment guidance
        </Link>
      </Section>

      <Section title="Roles">
        <FoundationScale
          items={SPACE_ROLES.map((item) => ({
            token: item.token,
            value: item.pointsAt,
            use: item.use,
          }))}
        />
      </Section>
    </>
  );
}
