import { useState } from "react";
import {
  ArrowRightIcon,
  PlusIcon,
  GearIcon,
} from "../../../../src/shared/design-system/icons";
import { Avatar } from "../../../../src/shared/design-system/ui/Avatar";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../../../src/shared/design-system/ui/Menu";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";

const variants = [
  "prominent",
  "subtle",
  "ghost",
  "inverted",
  "destructive",
  "outline",
  "link",
] as const;
const sizes = ["sm", "md", "lg"] as const;
const descriptions = {
  prominent: "The main action in a group.",
  subtle: "A supporting action with a quiet fill.",
  ghost: "A low-emphasis action without a resting fill.",
  inverted: "An action on an inverse surface.",
  destructive: "An action that removes or destroys something.",
  outline: "A supporting action with a visible boundary.",
  link: "An action that underlines on interaction.",
};

/** Viewer-only matrix: both pages exercise the production controls. */
function ButtonMatrix({ kind }: { kind: "text" | "icon" }) {
  const [state, setState] = useState<"enabled" | "disabled" | "loading">(
    "enabled",
  );
  return (
    <section
      aria-label={`${kind === "text" ? "Button" : "Icon button"} variants`}
      className="component-specimen-stack"
    >
      <div className="space-y-2">
        <h2 className="text-label">Emphasis and sizes</h2>
        <p className="text-body-sm text-subtle">
          Small · 32px, medium · 40px, large · 52px. Hover, press, or Tab
          through the controls to inspect their states.
        </p>
        <fieldset className="flex flex-wrap gap-2" aria-label="Preview state">
          {(["enabled", "disabled", "loading"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={state === value ? "prominent" : "subtle"}
              aria-pressed={state === value}
              onClick={() => setState(value)}
            >
              Show {value}
            </Button>
          ))}
        </fieldset>
      </div>
      {variants.map((variant) => (
        <section
          key={variant}
          aria-label={`${variant} examples`}
          className="component-specimen-group"
        >
          <h3 className="text-body-sm text-tertiary">
            {variant} · {descriptions[variant]}
          </h3>
          <div
            className={`component-specimen-frame ${variant === "inverted" ? "bg-surface-inverse" : ""}`}
          >
            <div className="component-specimen-row">
              {(kind === "text" ? (["xs", ...sizes] as const) : sizes).map(
                (size) => (
                  <div key={size} className="component-specimen">
                    {kind === "icon" ? (
                      <IconButton
                        aria-label={`${variant} ${size}`}
                        size={size}
                        variant={variant}
                        icon={<PlusIcon aria-hidden="true" />}
                        disabled={state === "disabled"}
                        loading={state === "loading"}
                      />
                    ) : (
                      <Button
                        size={size}
                        variant={variant}
                        aria-label={`${variant} ${size}`}
                        disabled={state === "disabled"}
                        loading={state === "loading"}
                      >
                        <ArrowRightIcon aria-hidden="true" /> Continue
                      </Button>
                    )}
                    <code
                      className={`component-specimen-prop text-mono-sm ${variant === "inverted" ? "text-inverse" : "text-tertiary"}`}
                    >
                      size="{size}"
                    </code>
                  </div>
                ),
              )}
            </div>
          </div>
        </section>
      ))}
    </section>
  );
}

export function ButtonSpecimen() {
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="component-specimen-stack">
      <div className="component-specimen-frame justify-center">
        <Button>Continue</Button>
      </div>
      <ButtonMatrix kind="text" />
      <section
        aria-label="Button behavior"
        className="component-specimen-group"
      >
        <h2 className="text-body-sm text-tertiary">Loading and expansion</h2>
        <p className="text-body-sm text-subtle">
          Saving keeps the same width and focus. Finish the example with the
          separate completion control.
        </p>
        <div className="component-specimen-frame">
          <div className="min-w-0 space-y-4">
            <div className="component-specimen-row">
              <Button
                loading={loading}
                variant="prominent"
                onClick={() => setLoading(true)}
              >
                Save changes
              </Button>
              <Button disabled={!loading} onClick={() => setLoading(false)}>
                Complete saving
              </Button>
            </div>
            <Button
              aria-expanded={expanded}
              aria-controls="button-example-details"
              onClick={() => setExpanded(!expanded)}
            >
              Show details
            </Button>
            <p
              id="button-example-details"
              hidden={!expanded}
              className="text-body-sm text-subtle"
            >
              The trigger keeps its pressed emphasis while this content is
              expanded.
            </p>
          </div>
        </div>
      </section>
      <section aria-label="Button content" className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">Single-line labels</h2>
        <p className="text-body-sm text-subtle">
          Labels stay on one line. Let the surrounding layout wrap whole
          controls or scroll when space is limited, rather than squeezing the
          label.
        </p>
        <div className="component-specimen-frame">
          <div className="min-w-0 space-y-4">
            <div className="component-specimen-row">
              <Button>Text only</Button>
              <Button>
                <PlusIcon aria-hidden="true" /> Create project
              </Button>
              <Button>
                Continue <ArrowRightIcon aria-hidden="true" />
              </Button>
              <Button variant="outline">Choose a workspace</Button>
            </div>
            <div className="flex w-full max-w-96 items-center gap-4">
              <p className="m-0 min-w-0 flex-1 text-body-sm text-secondary">
                Changes affect future starts and restarts. Running work is never
                restarted automatically.
              </p>
              <Button variant="prominent">Apply changes</Button>
            </div>
            <div className="max-w-48">
              <Button>
                <PlusIcon aria-hidden="true" /> Allow notifications for this
                workspace
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export function IconButtonSpecimen() {
  return (
    <div className="component-specimen-stack">
      <div className="component-specimen-frame justify-center">
        <IconButton
          aria-label="Add item"
          icon={<PlusIcon aria-hidden="true" />}
        />
      </div>
      <ButtonMatrix kind="icon" />
      <div className="component-specimen-frame">
        <IconButton
          size="xs"
          shape="control"
          aria-label="Dense formatting option"
          title="Dense formatting option (28px)"
          icon={<PlusIcon />}
        />
        <code className="text-mono-sm">size="xs" · 28px</code>
      </div>
      <section
        className="component-specimen-group"
        aria-label="Buzz icon treatments"
      >
        <h2 className="text-body-sm text-tertiary">Buzz treatments</h2>
        <p className="text-body-sm text-subtle">
          Tint supports quiet composer actions. Chrome uses the workspace glass
          material. Round is the default; control corners remain an explicit
          option.
        </p>
        <div className="component-specimen-frame">
          <div className="component-specimen-row">
            <IconButton
              variant="tint"
              aria-label="Tinted add"
              icon={<PlusIcon aria-hidden="true" />}
            />
            <IconButton
              variant="subtle"
              shape="control"
              aria-label="Control shape"
              icon={<GearIcon aria-hidden="true" />}
            />
          </div>
        </div>
      </section>
      <section
        className="component-specimen-group"
        aria-label="Avatar icon treatments"
      >
        <h2 className="text-body-sm text-tertiary">
          Avatar · Transparent cutouts
        </h2>
        <p className="text-body-sm text-subtle">
          Hover, press, or open the menu: the backdrop stays visible through the
          avatar cutout. Tab to the enabled control to inspect keyboard focus.
        </p>
        <div
          className="component-specimen-frame"
          style={{ background: "var(--bg-app)" }}
        >
          <div className="component-specimen-row">
            <MenuRoot>
              <MenuTrigger
                render={
                  <IconButton
                    variant="avatar"
                    aria-label="Avatar profile menu"
                    icon={
                      <Avatar
                        alt="Alex Morgan"
                        fallback="A"
                        size="fill"
                        statusBadge="online"
                      />
                    }
                  />
                }
              />
              <MenuPopup size="compact">
                <MenuItem>View profile</MenuItem>
              </MenuPopup>
            </MenuRoot>
            <IconButton
              variant="avatar"
              disabled
              aria-label="Disabled avatar profile"
              icon={
                <Avatar
                  alt="Sam Rivera"
                  fallback="S"
                  size="fill"
                  statusBadge="away"
                />
              }
            />
          </div>
        </div>
      </section>
      <section
        className="component-specimen-group"
        aria-label="Chrome icon treatments"
      >
        <h2 className="text-body-sm text-tertiary">
          Chrome · Workspace glass material
        </h2>
        <div
          className="component-specimen-frame"
          style={{ background: "var(--bg-app)" }}
        >
          <div className="component-specimen-row">
            <IconButton
              variant="chrome"
              aria-label="Chrome settings"
              icon={<GearIcon aria-hidden="true" />}
            />
            <IconButton
              variant="chrome"
              disabled
              aria-label="Disabled chrome settings"
              icon={<GearIcon aria-hidden="true" />}
            />
          </div>
        </div>
      </section>
      <section
        className="component-specimen-group"
        aria-label="Media icon treatment"
      >
        <h2 className="text-body-sm text-tertiary">
          Media · Static dark glass over video
        </h2>
        <div
          className="component-specimen-frame"
          style={{ background: "var(--bg-app)" }}
        >
          <IconButton
            variant="media"
            aria-label="Media settings"
            icon={<GearIcon aria-hidden="true" />}
          />
        </div>
      </section>
    </div>
  );
}
