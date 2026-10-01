import { useId, useState, type ReactNode } from "react";
import { Accordion } from "../../../../src/shared/design-system/ui/Accordion";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { Checkbox } from "../../../../src/shared/design-system/ui/Checkbox";
import { Dialog } from "../../../../src/shared/design-system/ui/Dialog";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import {
  Radio,
  RadioGroup,
} from "../../../../src/shared/design-system/ui/RadioGroup";
import { Textarea } from "../../../../src/shared/design-system/ui/Textarea";

/** Viewer-only compositions of the shared dialog; no product behavior or new variants. */
function Example({
  label,
  description,
  title,
  intro,
  action = "Save",
  informational = false,
  height,
  bodyLayout,
  children,
}: {
  label: string;
  description: string;
  title: string;
  intro?: string;
  action?: string;
  informational?: boolean;
  height?: "content" | "stable";
  bodyLayout?: "flow" | "flex";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section
      className="component-specimen-group"
      aria-labelledby={`${id}-label`}
    >
      <h2 id={`${id}-label`} className="text-label">
        {label}
      </h2>
      <p className="text-body-sm text-subtle">{description}</p>
      <div className="component-specimen-frame">
        <div className="flex w-full justify-center">
          <Button onClick={() => setOpen(true)}>Open dialog</Button>
        </div>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        {...(height ? { height } : {})}
        {...(bodyLayout ? { bodyLayout } : {})}
        {...(intro ? { description: intro } : {})}
        actions={
          informational ? (
            <Button variant="prominent" onClick={() => setOpen(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="prominent" type="submit" form={`${id}-form`}>
                {action}
              </Button>
            </>
          )
        }
      >
        {informational ? (
          children
        ) : (
          <form
            id={`${id}-form`}
            className="space-y-section-gap"
            onSubmit={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
          >
            {children}
          </form>
        )}
      </Dialog>
    </section>
  );
}

export function DialogSpecimens() {
  return (
    <div className="space-y-section-gap">
      <Example
        label="Simple message"
        description="A short message and a single action when no input is needed."
        title="A place for your team"
        informational
      >
        <p className="text-body">
          Keep project notes, conversations, and shared decisions together in
          one workspace.
        </p>
      </Example>
      <Example
        label="Stable height"
        description="Reserve space when content changes. The body scrolls while the title and actions stay in place."
        title="Browse options"
        height="stable"
        informational
      >
        <Accordion
          items={[
            {
              value: "details",
              title: "More details",
              content: (
                <p className="text-body">
                  Expanding content does not resize this dialog.
                </p>
              ),
            },
          ]}
        />
      </Example>
      <Example
        label="Fixed controls and scrolling content"
        description="A fixed search field above a single list that fills the remaining height."
        title="Browse people"
        height="stable"
        bodyLayout="flex"
        informational
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="shrink-0">
            <Input aria-label="Search people" placeholder="Search people" />
          </div>
          <section className="min-h-0 flex-1 overflow-auto" aria-label="People">
            {Array.from(
              { length: 20 },
              (_, index) => `Person ${index + 1}`,
            ).map((name) => (
              <p key={name} className="py-2 text-body-sm">
                {name}
              </p>
            ))}
          </section>
        </div>
      </Example>
      <Example
        label="Single field"
        description="A focused edit with one field and a clear save action."
        title="Edit workspace"
        intro="Choose a name your team will recognize."
      >
        <Field label="Workspace name">
          <Input defaultValue="Project notes" required />
        </Field>
      </Example>
      <Example
        label="Choose an option"
        description="A short list of mutually exclusive choices, with room to explain each one."
        title="Who can join?"
        intro="Choose how people join this workspace."
        action="Apply"
      >
        <Field label="Workspace access">
          <RadioGroup defaultValue="invite" name="access">
            <Radio
              value="invite"
              label="Invite only"
              description="Only people you invite can join."
            />
            <Radio
              value="request"
              label="Request access"
              description="People can ask an owner to join."
            />
            <Radio
              value="team"
              label="Anyone on the team"
              description="Your whole team can find and join this workspace."
            />
          </RadioGroup>
        </Field>
      </Example>
      <Example
        label="Short form"
        description="Related fields in one column, with helper text and a primary action."
        title="Create a project"
        intro="Give your team a shared place to get started."
        action="Create project"
      >
        <div className="space-y-4">
          <Field label="Project name">
            <Input placeholder="Website refresh" required />
          </Field>
          <Field
            label="Description"
            description="A sentence or two about what you're working on."
          >
            <Textarea
              rows={3}
              placeholder="What should this project accomplish?"
            />
          </Field>
          <Checkbox
            label="Let teammates discover this project"
            defaultChecked
          />
        </div>
      </Example>
      <Example
        label="Grouped settings"
        description="A longer form with named sections and optional details. Content and actions share one scroll area on smaller screens."
        title="Workspace settings"
        intro="Manage the details and defaults for your workspace."
        action="Save changes"
      >
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-label">General</legend>
          <Field label="Workspace name">
            <Input defaultValue="Design studio" required />
          </Field>
          <Field label="Description">
            <Textarea
              rows={3}
              defaultValue="A shared space for design reviews, experiments, and team decisions."
            />
          </Field>
        </fieldset>
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-label">Access</legend>
          <Field label="Who can join">
            <RadioGroup defaultValue="invite" name="workspace-access">
              <Radio
                value="invite"
                label="Invite only"
                description="An owner needs to invite each new member."
              />
              <Radio
                value="team"
                label="Anyone on the team"
                description="Teammates can join without an invitation."
              />
            </RadioGroup>
          </Field>
          <Field
            label="Contact email"
            description="Where people can ask for access."
          >
            <Input type="email" placeholder="team@example.com" />
          </Field>
        </fieldset>
        <fieldset className="min-w-0 space-y-4">
          <legend className="mb-4 text-label">Notifications</legend>
          <Checkbox label="Notify me when someone joins" defaultChecked />
          <Checkbox label="Send a weekly activity summary" />
          <Checkbox
            label="Include project updates in summaries"
            defaultChecked
          />
        </fieldset>
        <div>
          <h3 className="mb-2 text-label">Advanced</h3>
          <div className="-mx-2">
            <Accordion
              variant="form"
              keepMounted
              items={[
                {
                  value: "defaults",
                  title: "Project defaults",
                  content: (
                    <div className="space-y-4">
                      <Field label="Default project description">
                        <Textarea
                          rows={3}
                          placeholder="A starting point for new projects"
                        />
                      </Field>
                      <Checkbox
                        label="Allow members to create projects"
                        defaultChecked
                      />
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </Example>
    </div>
  );
}
