import {
  BLUR,
  ELEVATION,
} from "../../../../src/shared/design-system/tokens/registry";

import { Note, PageHeader, Section } from "./primitives";

export function ElevationPage() {
  return (
    <>
      <PageHeader
        title="Elevation"
        intro="Use the two shared shadow roles to separate raised controls and floating surfaces. Keep shadows subtle; dark mode also uses lighter surfaces to show depth."
      />

      <Section title="The values">
        <div className="flex flex-wrap gap-6 rounded-xl bg-app p-8">
          {ELEVATION.map((level) => (
            <div key={level.token} className="flex flex-col gap-2">
              <div
                className="flex h-24 w-44 items-center justify-center rounded-xl bg-panel"
                style={{ boxShadow: `var(${level.variable})` }}
              >
                <code className="text-body-sm text-primary">{level.token}</code>
              </div>
              <span className="max-w-44 text-body-sm text-secondary">
                {level.use}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Blur lives here rather than on the glass page: it is a depth cue like
          a shadow, and the glass materials already carry their own blur, so
          showing the amounts beside the shadows keeps every depth value in one
          place. */}
      <Section
        title="Blur"
        description="Blur softens content behind a translucent surface. Choose a glass material to apply its fill, blur, and rim together."
      >
        <div className="glass-scene flex flex-wrap gap-3 rounded-xl p-6">
          {BLUR.map((blur) => (
            <div
              key={blur.token}
              className="glass-primary flex flex-col gap-1 rounded-xl px-5 py-4"
              style={{ backdropFilter: `blur(${blur.value})` }}
            >
              <code className="text-mono-sm text-primary">{blur.token}</code>
              <span className="text-body-sm text-tertiary">{blur.value}</span>
            </div>
          ))}
        </div>
      </Section>

      <Note>
        Floating surfaces use shadows in light mode and a lighter fill in dark
        mode. This is why surface-popover and surface-panel share a light value
        but differ in dark. Use the shared surface role rather than
        strengthening the shadow.
      </Note>
    </>
  );
}
