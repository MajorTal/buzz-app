import { useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Search, UserRound } from "lucide-react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconSearch,
  IconUser,
} from "@tabler/icons-react";
import { Avatar } from "../../../../src/shared/design-system/ui/Avatar";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import { Switch } from "../../../../src/shared/design-system/ui/Switch";
import { PageHeader } from "./primitives";
import "./componentAdoption.css";

/** Historical presentation specimens from #59 (95a0196), isolated to this viewer.
 * The left column is frozen markup/CSS, not a second product implementation.
 * Both columns intentionally share #59's unchanged palette and typography tokens.
 */
function ComparisonRow({
  name,
  source,
  change,
  before,
  after,
}: {
  name: string;
  source: string;
  change: string;
  before: ReactNode;
  after: ReactNode;
}) {
  return (
    <tr>
      <th scope="row">
        <span className="text-label">{name}</span>
        <p className="text-body-sm text-secondary">{change}</p>
        <code className="text-mono-sm text-secondary">{source}</code>
      </th>
      <td>
        <fieldset aria-label={`Before: ${name}`} className="adoption-sample">
          {before}
        </fieldset>
      </td>
      <td>
        <fieldset aria-label={`After: ${name}`} className="adoption-sample">
          {after}
        </fieldset>
      </td>
    </tr>
  );
}

export function ComponentAdoptionPage() {
  const [alerts, setAlerts] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [action, setAction] = useState("Controls act only in this preview.");
  const run = () => setAction("Action received. No app data was changed.");
  return (
    <div className="adoption-page">
      <PageHeader
        title="Component adoption"
        status="PR A · draft"
        intro="The same actions, rendered with one shared component language. Review the changes before the next design decisions."
      />
      <p className="text-body-sm text-secondary adoption-context">
        Before: PR #59, 95a0196. After: the shared components used by PR A. Both
        use Inter and the same foundation tokens. Use the viewer’s light/dark
        control to compare both modes.
      </p>
      <section
        className="adoption-table-scroll"
        aria-label="Component comparison"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: This horizontal scroll region must support keyboard scrolling.
        tabIndex={0}
      >
        <table className="adoption-table">
          <caption className="sr-only">
            Existing Buzz controls compared with their shared design-system
            replacements
          </caption>
          <thead>
            <tr>
              <th scope="col">Component and change</th>
              <th scope="col">Before · local styling</th>
              <th scope="col">After · shared system</th>
            </tr>
          </thead>
          <tbody>
            <ComparisonRow
              name="Action buttons"
              source="app/ProfileSettings.tsx"
              change="Native button recipes become Button. Default height is 36px; primary and quiet own their states."
              before={
                <>
                  <button
                    type="button"
                    className="adoption-old-button adoption-old-primary"
                    onClick={run}
                  >
                    Save profile
                  </button>
                  <button
                    type="button"
                    className="adoption-old-button"
                    onClick={run}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="adoption-old-button"
                    disabled
                  >
                    Save
                  </button>
                </>
              }
              after={
                <>
                  <Button variant="primary" onClick={run}>
                    Save profile
                  </Button>
                  <Button onClick={run}>Cancel</Button>
                  <Button disabled>Save</Button>
                </>
              }
            />
            <ComparisonRow
              name="Shell actions"
              source="app/shell/NavigationControls.tsx"
              change="IconButton owns the glass, round shape and disabled state. Artwork moves from 17px Lucide to 16px Tabler."
              before={
                <div className="adoption-chrome">
                  <button
                    type="button"
                    className="adoption-old-shell"
                    aria-label="Go back"
                    onClick={run}
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <button
                    type="button"
                    className="adoption-old-shell"
                    aria-label="Go forward"
                    disabled
                  >
                    <ArrowRight size={17} />
                  </button>
                  <button
                    type="button"
                    className="adoption-old-shell"
                    aria-label="Find a page"
                    onClick={run}
                  >
                    <Search size={17} />
                  </button>
                </div>
              }
              after={
                <div className="adoption-chrome">
                  <IconButton
                    variant="chrome"
                    shape="round"
                    aria-label="Go back"
                    icon={<IconArrowLeft size={16} />}
                    onClick={run}
                  />
                  <IconButton
                    variant="chrome"
                    shape="round"
                    aria-label="Go forward"
                    icon={<IconArrowRight size={16} />}
                    disabled
                  />
                  <IconButton
                    variant="chrome"
                    shape="round"
                    aria-label="Find a page"
                    icon={<IconSearch size={16} />}
                    onClick={run}
                  />
                </div>
              }
            />
            <ComparisonRow
              name="Notification switch"
              source="app/NotificationSettings.tsx"
              change="A browser checkbox becomes the existing labeled Switch. Clicking the label still toggles it."
              before={
                <label className="adoption-old-notification">
                  <span>Desktop alerts</span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={alerts}
                    checked={alerts}
                    onChange={(event) => setAlerts(event.target.checked)}
                  />
                </label>
              }
              after={
                <Switch
                  label="Desktop alerts"
                  checked={alerts}
                  onCheckedChange={setAlerts}
                />
              }
            />
            <ComparisonRow
              name="Plugin switch"
              source="app/Settings.tsx"
              change="The 48×28px custom track becomes the system’s 36×20px switch. Busy controls remain focusable and cannot toggle."
              before={
                <>
                  <button
                    type="button"
                    className="adoption-old-switch"
                    role="switch"
                    aria-label="Enable example plugin"
                    aria-checked={enabled}
                    onClick={() => setEnabled(!enabled)}
                  >
                    <span />
                  </button>
                  <button
                    type="button"
                    className="adoption-old-switch"
                    role="switch"
                    aria-label="Enable busy plugin"
                    aria-checked="true"
                    aria-disabled="true"
                  >
                    <span />
                  </button>
                  <span className="text-caption text-secondary">Busy</span>
                </>
              }
              after={
                <>
                  <Switch
                    aria-label="Enable example plugin"
                    checked={enabled}
                    onCheckedChange={setEnabled}
                  />
                  <Switch
                    aria-label="Enable busy plugin"
                    checked
                    readOnly
                    aria-disabled="true"
                  />
                  <span className="text-caption text-secondary">Busy</span>
                </>
              }
            />
            <ComparisonRow
              name="Mention avatars"
              source="bundled/mentions/MentionCompletion.tsx"
              change="Local 28px rounded avatars become the existing 24px small Avatar; picker rows use the 32px default. One shared initial/fallback treatment."
              before={
                <>
                  <span className="adoption-old-mention text-caption">AL</span>
                  <span className="adoption-old-mention adoption-old-mention-default text-caption">
                    JD
                  </span>
                </>
              }
              after={
                <>
                  <Avatar alt="Alex Lee" fallback="Alex Lee" size="small" />
                  <Avatar alt="Jamie Diaz" fallback="Jamie Diaz" />
                </>
              }
            />
            <ComparisonRow
              name="Message avatars"
              source="features/messages/MessageRow.tsx"
              change="40px identity artwork stays 40px. Avatar owns loading and failure fallback; IconButton owns the profile action."
              before={
                <button
                  type="button"
                  className="adoption-old-message text-caption"
                  aria-label="View Alex profile"
                  onClick={run}
                >
                  AL
                </button>
              }
              after={
                <IconButton
                  size="large"
                  shape="round"
                  aria-label="View Alex profile"
                  icon={<Avatar alt="" fallback="Alex" size="fill" />}
                  onClick={run}
                />
              }
            />
            <ComparisonRow
              name="Icon family"
              source="app · features · bundled views"
              change="React UI icons now use the system’s Tabler family. Identity artwork and Emoji Mart’s internal icons remain separate."
              before={
                <>
                  <ArrowLeft size={20} />
                  <Search size={20} />
                  <UserRound size={20} />
                </>
              }
              after={
                <>
                  <IconArrowLeft size={20} />
                  <IconSearch size={20} />
                  <IconUser size={20} />
                </>
              }
            />
          </tbody>
        </table>
      </section>
      <p role="status" className="text-body-sm text-secondary adoption-context">
        {action}
      </p>
      <p className="text-body-sm text-secondary">
        Historical samples reproduce the named controls’ #59 presentation; they
        are not screenshots of complete screens. Forms, navigation rows,
        dialogs, composer tools and picker internals have later adoption
        batches. No new density variants or foundation values are introduced
        here.
      </p>
    </div>
  );
}
