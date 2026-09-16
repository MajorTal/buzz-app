import { useState } from "react";
import { IconCheck } from "@tabler/icons-react";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { Panel } from "../../../../src/shared/design-system/ui/Panel";
import { PanelHeader } from "../../../../src/shared/design-system/ui/PanelHeader";
import { Switch } from "../../../../src/shared/design-system/ui/Switch";
import { PageHeader, Section } from "./primitives";
import { AlignmentRules } from "./alignmentRules";
import "./foundationAlignment.css";

type Treatment = {
  statusColor: boolean;
  readingSize: boolean;
  sectionSpace: boolean;
};

const CURRENT: Treatment = {
  statusColor: false,
  readingSize: false,
  sectionSpace: false,
};

/** A viewer composition of shared components; changes are local to this proposal. */
function ProjectSpecimen({
  label,
  treatment,
}: {
  label: string;
  treatment: Treatment;
}) {
  const [following, setFollowing] = useState(false);
  return (
    <section aria-label={label} className="alignment-specimen">
      <h3 className="text-body font-semibold text-primary">{label}</h3>
      <Panel aria-label={`${label} project`}>
        <PanelHeader
          title={<h4 className="text-heading text-primary">Launch notes</h4>}
        />
        <div
          className="alignment-project"
          data-spacing={treatment.sectionSpace ? "proposed" : "current"}
        >
          <div className="alignment-group">
            <p className="text-body-sm text-secondary">Project overview</p>
            <p
              className={`${treatment.readingSize ? "text-body-lg" : "text-body"} text-primary`}
              data-reading
            >
              Bring the release notes, open questions, and next steps together
              so everyone can pick up where the team left off.
            </p>
          </div>
          <div className="alignment-group">
            <h5 className="text-heading text-primary">Before we share</h5>
            <ul className="alignment-tasks text-body">
              <li>
                <span>Review the draft</span>
                <span
                  data-status
                  className={`alignment-status ${treatment.statusColor ? "text-green-12" : "text-primary"}`}
                >
                  <IconCheck size={16} aria-hidden="true" />
                  Complete
                </span>
              </li>
              <li>
                <span>Resolve open questions</span>
                <span className="text-secondary">In progress</span>
              </li>
            </ul>
          </div>
          <div className="alignment-group">
            <Button
              variant="quiet"
              aria-pressed={following}
              onClick={() => setFollowing((value) => !value)}
            >
              {following ? "Following project" : "Follow project"}
            </Button>
            <p className="text-body-sm text-secondary" role="status">
              {following ? "Following in this preview." : "Preview only."}
            </p>
          </div>
        </div>
      </Panel>
    </section>
  );
}

/** Compare a small set of foundation choices before changing shared defaults. */
export function FoundationAlignmentPage() {
  const [treatment, setTreatment] = useState<Treatment>(CURRENT);
  return (
    <>
      <PageHeader
        title="Foundation alignment"
        status="proposal"
        intro="Selected BlockUI conventions, expressed through Buzz’s existing tokens. Change one choice at a time."
      />
      <Section title="Compare">
        <fieldset className="alignment-options">
          <legend className="text-body font-semibold text-primary">
            Proposed choices
          </legend>
          <Switch
            label="Status color"
            checked={treatment.statusColor}
            onCheckedChange={(statusColor) =>
              setTreatment((value) => ({ ...value, statusColor }))
            }
          />
          <Switch
            label="Larger reading text"
            checked={treatment.readingSize}
            onCheckedChange={(readingSize) =>
              setTreatment((value) => ({ ...value, readingSize }))
            }
          />
          <Switch
            label="More section space"
            checked={treatment.sectionSpace}
            onCheckedChange={(sectionSpace) =>
              setTreatment((value) => ({ ...value, sectionSpace }))
            }
          />
        </fieldset>
        <p className="text-body-sm text-secondary">
          Both samples start alike. These are viewer compositions, not captures
          of a shipping screen. Shared defaults stay unchanged.
        </p>
        <div className="alignment-comparison">
          <ProjectSpecimen label="Current tokens" treatment={CURRENT} />
          <ProjectSpecimen label="Selected proposal" treatment={treatment} />
        </div>
      </Section>
      <AlignmentRules />
    </>
  );
}
