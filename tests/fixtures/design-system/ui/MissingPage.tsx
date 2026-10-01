import { PageHeader } from "./primitives";
import { Link } from "@tanstack/react-router";

/**
 * What a stale or renamed link lands on.
 *
 * Deep links are how pages get shared, so a link outliving its page is normal
 * rather than exceptional — and the failure it produced was an empty reading
 * column, which reads as a broken viewer instead of a moved page. Saying so and
 * offering the way back keeps the reader oriented.
 */
export function MissingPage({ what = "page" }: { what?: string }) {
  return (
    <>
      <PageHeader
        title="Not in the system"
        intro={
          <>
            This {what} does not exist, or its link changed. The navigation
            lists everything the system documents.
          </>
        }
      />
      <p className="text-body text-secondary">
        <Link to="/design" className="text-purple-12 underline">
          Go to the overview
        </Link>
      </p>
    </>
  );
}
