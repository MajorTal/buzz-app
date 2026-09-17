/**
 * The token registry.
 *
 * This is the machine-readable description of the colour system: what exists,
 * what each name is for, what it points at, and whether it is core or proposed.
 * The design system pages render from this, so a token added here appears in the
 * documentation automatically and the docs cannot drift from the system.
 *
 * Adding to this file is a normal, unreviewed action — see the growth procedure
 * in DESIGN.md. Every entry needs a `use` sentence and, if proposed, an `owner`.
 */

/** Whether a token is part of the vetted system or someone's addition. */
export type TokenStatus = "core" | "proposed" | "deprecated";

/** A private ramp step. Components never reference these. */
export interface RampStep {
  /** Position on the ramp. The number means a job, not a brightness. */
  step: number;
  /** What this step is for. */
  job: string;
  /** The CSS custom property, without `var()`. */
  variable: string;
}

/** A private ramp. */
export interface Ramp {
  id: string;
  name: string;
  /** Why this ramp exists and how it behaves. */
  description: string;
  steps: RampStep[];
  /** Rendered over the app backdrop so translucency is visible. */
  translucent?: boolean;
}

/** A public role. The only layer a screen may use. */
export interface Role {
  /** The Tailwind class, e.g. `bg-panel`. */
  token: string;
  /** The CSS custom property backing it. */
  variable: string;
  /** What it points at, for display: `neutral 1`, or a note for exceptions. */
  pointsAt: string;
  /** One sentence: when to use this. */
  use: string;
  status: TokenStatus;
  /** Required when status is `proposed`. */
  owner?: string;
  /** Set when the value is a literal rather than a ramp reference. */
  exception?: string;
}

export interface RoleGroup {
  id: string;
  name: string;
  description: string;
  roles: Role[];
}

/* ============================================================
   PRIVATE RAMPS
   ============================================================ */

/**
 * What each of the twelve steps is *for*, as a starting point.
 *
 * The same twelve jobs in every hue is what makes a twelve-step scale useful and
 * the step-to-role mapping deterministic: a role picks a step number, not a
 * colour.
 *
 * **These are the scale's general intentions, not a record of Buzz's decisions,
 * and the two have already diverged.** The list came with the values and said
 * step 4 was "component hover" and step 6 "subtle border" — while in this product
 * step 4 is the one border weight and step 6 has one reader on a documentation
 * page. A generic label that contradicts the product is worse than none, because
 * a designer reading `/design` takes it for a decision someone made.
 *
 * So: **the label answers "what is this step generally for", and the neutral
 * ramp's own comments in `tokens.css` answer "what does Buzz actually do with
 * it".** When a step's real use settles into something durable, move it here.
 * `pnpm census` lists the real readers of every role.
 */
const STEP_JOBS = [
  "lightest surface",
  "subtle surface",
  "tinted surface",
  "tinted surface, hovered",
  "quiet border, or a selected surface",
  "border",
  "stronger border",
  "border hover, focus ring",
  "solid fill",
  "solid fill, hovered",
  "text on a tint, or an inverse fill",
  "high-contrast text",
];

/** A palette hue: twelve steps, authored per mode. The bottom layer. */
export interface PaletteHue {
  id: string;
  /** Which identity, if any, currently draws from this hue. */
  usedBy?: string;
  steps: Array<{ step: number; variable: string; job: string }>;
}

/**
 * A private, named backdrop treatment.
 *
 * Unlike a colour ramp, a treatment is a complete visual composition: several
 * colours plus their positions, falloff, and sometimes a vignette. Its name is
 * deliberately mode-specific — Night garden is the dark counterpart of Sky
 * field, not Sky field with its brightness turned down.
 */
export interface BackdropTreatment {
  id: string;
  name: string;
  variable: string;
  mode: "light" | "dark";
  pairedWith: string;
  description: string;
}

/**
 * Every hue in the palette.
 *
 * The bottom layer, and the only place a literal colour lives.
 * Values are Radix Colors (MIT), transcribed rather than depended on — Radix is
 * not on Block's Tech Radar, so this is a values-only copy with no package.
 *
 * It exists for two reasons. The tokens above it were 114 hand-picked hex
 * values with nothing enforcing that two tokens doing the same job agreed, and
 * they drifted. And a hue's dark steps are not its light steps dimmed: reaching
 * for a subtler dark purple by writing `purple-950/50` in a component put a real
 * colour decision somewhere it could not be named, paired, or measured.
 */
export const PALETTE: PaletteHue[] = [
  { id: "neutral", usedBy: "structure", steps: [] },
  { id: "purple", usedBy: "accent", steps: [] },
  { id: "red", usedBy: "danger", steps: [] },
  { id: "green", usedBy: "success", steps: [] },
  { id: "amber", usedBy: "warning", steps: [] },
  { id: "blue", usedBy: "info", steps: [] },
  { id: "cyan", steps: [] },
  { id: "orange", steps: [] },
].map((hue) => ({
  ...hue,
  steps: Array.from({ length: 12 }, (_, i) => ({
    step: i + 1,
    variable: `--${hue.id}-${i + 1}`,
    job: STEP_JOBS[i] ?? "Palette step",
  })),
}));

export const BACKDROP_TREATMENTS: BackdropTreatment[] = [
  {
    id: "sky-field",
    name: "Sky field",
    variable: "--gradient-sky-field",
    mode: "light",
    pairedWith: "night-garden",
    description: "Blue sky, fresh green, and a sunlit yellow edge.",
  },
  {
    id: "peach-field",
    name: "Peach field",
    variable: "--gradient-peach-field",
    mode: "light",
    pairedWith: "signal-flare",
    description: "A bright peach wash with a cool blue edge.",
  },
  {
    id: "blue-hour",
    name: "Blue hour",
    variable: "--gradient-blue-hour",
    mode: "light",
    pairedWith: "electric-dusk",
    description: "Cyan, periwinkle, and a quiet lavender horizon.",
  },
  {
    id: "orchid-field",
    name: "Orchid field",
    variable: "--gradient-orchid-field",
    mode: "light",
    pairedWith: "ultraviolet",
    description: "Lilac, periwinkle, and a low orchid-pink bloom.",
  },
  {
    id: "night-garden",
    name: "Night garden",
    variable: "--gradient-night-garden",
    mode: "dark",
    pairedWith: "sky-field",
    description: "Deep teal atmosphere, emerald high light, and blue below.",
  },
  {
    id: "signal-flare",
    name: "Signal flare",
    variable: "--gradient-signal-flare",
    mode: "dark",
    pairedWith: "peach-field",
    description:
      "A warm ember field with orange high light and a rose horizon.",
  },
  {
    id: "electric-dusk",
    name: "Electric dusk",
    variable: "--gradient-electric-dusk",
    mode: "dark",
    pairedWith: "blue-hour",
    description: "Cyan and ultraviolet light over a deep blue atmosphere.",
  },
  {
    id: "ultraviolet",
    name: "Ultraviolet",
    variable: "--gradient-ultraviolet",
    mode: "dark",
    pairedWith: "orchid-field",
    description: "A deep violet field, blue high light, and a low rose flare.",
  },
];

/** The four stable appearance slots, each pairing one light and dark scene. */
export const BACKDROP_CHOICES = [
  {
    token: "gradient-1",
    variable: "--gradient-1",
    lightTreatment: "sky-field",
    darkTreatment: "night-garden",
    use: "The default app backdrop: Sky field in light mode, Night garden in dark.",
  },
  {
    token: "gradient-2",
    variable: "--gradient-2",
    lightTreatment: "peach-field",
    darkTreatment: "signal-flare",
    use: "A warm paired app backdrop: Peach field in light mode, Signal flare in dark.",
  },
  {
    token: "gradient-3",
    variable: "--gradient-3",
    lightTreatment: "blue-hour",
    darkTreatment: "electric-dusk",
    use: "A cool paired app backdrop: Blue hour in light mode, Electric dusk in dark.",
  },
  {
    token: "gradient-4",
    variable: "--gradient-4",
    lightTreatment: "orchid-field",
    darkTreatment: "ultraviolet",
    use: "A violet paired app backdrop: Orchid field in light mode, Ultraviolet in dark.",
  },
] as const;

export const RAMPS: Ramp[] = [
  {
    id: "glass",
    name: "Glass",
    description:
      "A translucency ramp of fills. Each step is the mode's surface colour at an increasing opacity, which is what lets a hover move one step up the ramp instead of holding its own literal. Fills only — a glass surface's bright rim is a border, and it is a documented exception.",
    translucent: true,
    steps: [
      { step: 1, job: "barely there", variable: "--glass-1" },
      { step: 2, job: "quiet glass", variable: "--glass-2" },
      { step: 3, job: "default glass", variable: "--glass-3" },
      { step: 4, job: "glass hovered", variable: "--glass-4" },
      { step: 5, job: "nearly solid", variable: "--glass-5" },
    ],
  },
];

/* ============================================================
   PUBLIC ROLES
   ============================================================ */

/**
 * There is no identity-group generator any more, and that is the point.
 *
 * A helper here built five roles from one line of a hue lookup — `bg-accent`,
 * `bg-accent-tint`, `text-accent`, and so on — which is exactly how twenty status
 * roles came to exist without anyone designing them. Every one of those roles
 * held the same palette step in both modes, so each was a name in front of a
 * number.
 *
 * Screens now write the step: `bg-purple-9`, `bg-purple-3`, `text-purple-12`.
 * Safe here and not in Tailwind because **every step is authored per mode**, so a
 * class still behaves in light and dark. The step-to-role mapping in DESIGN.md
 * survives as guidance for *which* step to reach for; it is no longer a
 * generator.
 *
 * A name comes back when a repeated accent PATTERN appears — a tinted callout on
 * four screens — and it will be named for the pattern, not the colour.
 */

export const ROLE_GROUPS: RoleGroup[] = [
  {
    id: "semantic-surface",
    name: "Surface",
    description: "Shared surface roles, with values for both themes.",
    roles: [
      {
        token: "bg-surface-base",
        variable: "--surface-base",
        pointsAt: "neutral-2 light / neutral-1 dark",
        use: "The plain background behind panels.",
        status: "core",
      },
      {
        token: "bg-surface-panel",
        variable: "--surface-panel",
        pointsAt: "neutral-1 light / neutral-3 dark",
        use: "A content panel or card.",
        status: "core",
      },
      {
        token: "bg-surface-popover",
        variable: "--surface-popover",
        pointsAt: "neutral-1 light / neutral-5 dark",
        use: "A menu, dialog or other raised surface.",
        status: "core",
      },
      {
        token: "bg-surface-inset",
        variable: "--surface-inset",
        pointsAt: "neutral-2 light / neutral-2 dark",
        use: "A recessed region inside a panel.",
        status: "core",
      },
    ],
  },
  {
    id: "semantic-text",
    name: "Text",
    description: "Shared text roles, with values for both themes.",
    roles: [
      {
        token: "text-standard",
        variable: "--text-standard",
        pointsAt: "neutral-12 light / neutral-12 dark",
        use: "Normal reading text.",
        status: "core",
      },
      {
        token: "text-subtle",
        variable: "--text-subtle",
        pointsAt: "neutral-10 light / neutral-11 dark",
        use: "Supporting text that must remain readable.",
        status: "core",
      },
      {
        token: "text-metadata",
        variable: "--text-metadata",
        pointsAt: "neutral-9 light / neutral-10 dark",
        use: "Nonessential metadata.",
        status: "core",
      },
      {
        token: "text-inverse",
        variable: "--text-inverse",
        pointsAt: "neutral-1 light / neutral-1 dark",
        use: "Text on prominent actions.",
        status: "core",
      },
      {
        token: "text-unavailable",
        variable: "--text-unavailable",
        pointsAt: "neutral-7 light / neutral-7 dark",
        use: "Unavailable controls only.",
        status: "core",
      },
      {
        token: "text-danger",
        variable: "--text-danger",
        pointsAt: "red-12 light / red-12 dark",
        use: "Error text and destructive action labels.",
        status: "core",
      },
      {
        token: "text-warning",
        variable: "--text-warning",
        pointsAt: "amber-12 light / amber-12 dark",
        use: "Warning text.",
        status: "core",
      },
      {
        token: "text-success",
        variable: "--text-success",
        pointsAt: "green-12 light / green-12 dark",
        use: "Success text.",
        status: "core",
      },
      {
        token: "text-link",
        variable: "--text-link",
        pointsAt: "blue-12 light / blue-12 dark",
        use: "Inline links and mentions in prose.",
        status: "core",
      },
      {
        token: "text-accent",
        variable: "--text-accent",
        pointsAt: "purple-12 light / purple-12 dark",
        use: "Linked or selected identity text.",
        status: "core",
      },
    ],
  },
  {
    id: "semantic-border",
    name: "Border",
    description: "Shared border roles, with values for both themes.",
    roles: [
      {
        token: "border-standard",
        variable: "--border-standard",
        pointsAt: "neutral-3 light / neutral-4 dark",
        use: "A quiet separator or panel edge.",
        status: "core",
      },
      {
        token: "border-prominent",
        variable: "--border-prominent",
        pointsAt: "neutral-8 light / neutral-8 dark",
        use: "A visible input or choice boundary.",
        status: "core",
      },
      {
        token: "border-focus",
        variable: "--border-focus",
        pointsAt: "neutral-12 light / neutral-12 dark",
        use: "Keyboard focus.",
        status: "core",
      },
      {
        token: "border-danger",
        variable: "--border-danger",
        pointsAt: "red-8 light / red-8 dark",
        use: "Invalid field boundary.",
        status: "core",
      },
      {
        token: "border-warning",
        variable: "--border-warning",
        pointsAt: "amber-8 light / amber-8 dark",
        use: "Warning boundary.",
        status: "core",
      },
      {
        token: "border-accent",
        variable: "--border-accent",
        pointsAt: "purple-8 light / purple-8 dark",
        use: "An identity accent boundary.",
        status: "core",
      },
    ],
  },
  {
    id: "semantic-affordance",
    name: "Affordance",
    description: "Shared affordance roles, with values for both themes.",
    roles: [
      {
        token: "bg-affordance-prominent",
        variable: "--affordance-prominent",
        pointsAt: "neutral-12 light / neutral-12 dark",
        use: "The main action fill.",
        status: "core",
      },
      {
        token: "bg-affordance-prominent-hover",
        variable: "--affordance-prominent-hover",
        pointsAt: "neutral-11 light / neutral-11 dark",
        use: "The main action under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-prominent-pressed",
        variable: "--affordance-prominent-pressed",
        pointsAt: "neutral-action-pressed",
        use: "The main action while pressed.",
        status: "core",
      },
      {
        token: "bg-affordance-subtle",
        variable: "--affordance-subtle",
        pointsAt: "neutral-2 light / neutral-5 dark",
        use: "A secondary action fill.",
        status: "core",
      },
      {
        token: "bg-affordance-subtle-hover",
        variable: "--affordance-subtle-hover",
        pointsAt: "neutral-3 light / neutral-6 dark",
        use: "A secondary action under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-subtle-pressed",
        variable: "--affordance-subtle-pressed",
        pointsAt: "neutral-4 light / neutral-7 dark",
        use: "A secondary action while pressed.",
        status: "core",
      },
      {
        token: "bg-affordance-selected",
        variable: "--affordance-selected",
        pointsAt: "neutral-3 light / neutral-5 dark",
        use: "A persistently selected item.",
        status: "core",
      },
      {
        token: "bg-affordance-disabled",
        variable: "--affordance-disabled",
        pointsAt: "neutral-3 light / neutral-3 dark",
        use: "An unavailable control fill.",
        status: "core",
      },
      {
        token: "bg-affordance-danger",
        variable: "--affordance-danger",
        pointsAt: "red-3 light / red-3 dark",
        use: "A destructive action or error fill.",
        status: "core",
      },
      {
        token: "bg-affordance-danger-hover",
        variable: "--affordance-danger-hover",
        pointsAt: "red-4 light / red-4 dark",
        use: "A destructive action under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-danger-pressed",
        variable: "--affordance-danger-pressed",
        pointsAt: "red-5 light / red-5 dark",
        use: "A destructive action while pressed.",
        status: "core",
      },
      {
        token: "bg-affordance-warning",
        variable: "--affordance-warning",
        pointsAt: "amber-3 light / amber-3 dark",
        use: "A warning fill.",
        status: "core",
      },
      {
        token: "bg-affordance-success",
        variable: "--affordance-success",
        pointsAt: "green-3 light / green-3 dark",
        use: "A success fill.",
        status: "core",
      },
      {
        token: "bg-affordance-link-hover",
        variable: "--affordance-link-hover",
        pointsAt: "blue-4 light / blue-4 dark",
        use: "An inline link under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-accent",
        variable: "--affordance-accent",
        pointsAt: "purple-3 light / purple-3 dark",
        use: "A quiet identity or selection fill.",
        status: "core",
      },
      {
        token: "bg-affordance-accent-hover",
        variable: "--affordance-accent-hover",
        pointsAt: "purple-4 light / purple-4 dark",
        use: "A quiet identity fill under a pointer.",
        status: "core",
      },
      {
        token: "bg-affordance-accent-prominent",
        variable: "--affordance-accent-prominent",
        pointsAt: "purple-9 light / purple-9 dark",
        use: "An identity accent fill paired with text-on-accent.",
        status: "core",
      },
      {
        token: "bg-affordance-accent-prominent-hover",
        variable: "--affordance-accent-prominent-hover",
        pointsAt: "purple-10 light / purple-10 dark",
        use: "An identity accent fill under a pointer.",
        status: "core",
      },
    ],
  },

  {
    id: "surfaces",
    name: "Structural surfaces",
    description:
      "Legacy aliases maintained during migration. The original rationale was: each takes a different step in light and dark, so no single class like `bg-neutral-1` is correct in both. That is the whole test for whether a colour earns a name. Ask one question: is it behind, on, above, or in? (`bg-hover` was here and is now written as `bg-neutral-4` \u2014 it was the same step in both modes. Hover is a *relationship*, one step more contrast than whatever is underneath, which no single token could express anyway.)",
    roles: [
      {
        token: "bg-app",
        variable: "--bg-app",
        pointsAt: "gradient-1 (Sky field light / Night garden dark)",
        use: "The backdrop everything sits on. It takes the first paired appearance choice by default.",
        status: "core",
      },
      {
        token: "bg-panel",
        variable: "--bg-panel",
        pointsAt: "neutral 1 light / neutral 3 dark",
        use: "Everything sitting on the backdrop: the navigation column, content, timelines, cards, rows.",
        status: "core",
      },
      {
        token: "bg-float",
        variable: "--bg-float",
        pointsAt: "neutral 1 light / neutral 5 dark",
        use: "Anything hovering above the page: menus, dialogs, tooltips, toasts. Shares a light value with bg-panel and diverges in dark, because a shadow cannot carry elevation on a near-black background.",
        status: "core",
      },
    ],
  },
  {
    id: "emphasis",
    name: "Emphasis",
    description:
      "One three-level ramp shared by text and borders: normal, lesser, really lesser. States that are not levels of emphasis get their own names rather than extending the ramp.",
    roles: [
      {
        token: "text-primary",
        variable: "--text-primary",
        pointsAt: "neutral 12",
        use: "Normal reading text.",
        status: "core",
      },
      {
        token: "text-secondary",
        variable: "--text-secondary",
        pointsAt: "neutral 10",
        use: "Supporting text: author names, labels.",
        status: "core",
      },
      {
        token: "text-tertiary",
        variable: "--text-tertiary",
        pointsAt: "neutral 9",
        use: "Metadata: timestamps, counts, hints.",
        status: "core",
      },
      {
        token: "text-disabled",
        variable: "--text-disabled",
        pointsAt: "neutral 8",
        use: "Unavailable. A state, not a fourth level of the ramp.",
        status: "core",
      },
      {
        token: "border-primary",
        variable: "--border-primary",
        pointsAt: "neutral 4",
        use: "Every deliberate line: panel boundaries, dividers, separators. One quiet weight; add another only when a design proves a different boundary needs it.",
        status: "core",
      },
    ],
  },
  {
    id: "material",
    name: "Material",
    description:
      "Glass is applied as a whole material — a fill, a blur, a rim, and sometimes a lift — through the `glass-primary` and `glass-secondary` utilities. The fills below are what those utilities read; they are deliberately not registered as Tailwind colour utilities, because a bare `bg-glass-primary` class would be the fill without the rest, which is the failure the materials exist to prevent. Named by stacking depth: primary sits on the backdrop, secondary sits over something already glass. See the glass page.",
    roles: [
      {
        token: "glass-primary",
        variable: "--bg-glass-primary",
        pointsAt: "glass 2 + blur-md + rim",
        use: "Glass sitting directly on the backdrop: chrome, nav, a region in glass. The most translucent, because the backdrop is the thing worth seeing through to.",
        status: "core",
      },
      {
        token: "glass-secondary",
        variable: "--bg-glass-secondary",
        pointsAt: "glass 4 + blur-lg + rim + shadow-sm",
        use: "Glass over something already glass: popovers, menus, a modal over a panel. Less translucent so it separates, and a real shadow because it is genuinely above.",
        status: "core",
      },
      {
        token: "bg-chrome-selected",
        variable: "--bg-chrome-selected",
        pointsAt: "neutral 1 light / neutral 5 dark",
        use: "The selected item inside chrome. Opaque rather than a glass step, because on glass elevation reads as less translucency, not a lighter colour.",
        status: "core",
      },
      {
        token: "glass-primary-interactive",
        variable: "--bg-glass-primary-hover",
        pointsAt: "glass 3 on hover",
        use: "Primary glass you can click: chrome buttons, topbar controls. The hover moves one step up the ramp and never changes blur — re-blurring a large surface every frame is expensive enough to feel.",
        status: "core",
      },
    ],
  },
];

/* ============================================================
   THE VOCABULARY
   Every token in the system is built from these words. A new name
   combining existing words is routine; a new WORD is what the
   audit reports on its own line.
   ============================================================ */

export const VOCABULARY: Array<{ group: string; words: string[] }> = [
  { group: "property", words: ["bg", "text", "border", "ring"] },
  { group: "region", words: ["app", "panel", "float", "chrome", "inset"] },
  { group: "emphasis", words: ["primary", "secondary", "tertiary", "default"] },
  {
    group: "state",
    words: ["hover", "pressed", "selected", "disabled", "loading"],
  },
  { group: "material", words: ["glass"] },
  { group: "modifier", words: ["tint"] },
  { group: "identity", words: ["accent", "inverse"] },
  // Not a status vocabulary: `error` names one situation that needed a colour,
  // and `agent-running` names another. A tier vocabulary is what produced four
  // undesigned identities, so these stay concrete until a pattern repeats.
  { group: "situation", words: ["error", "agent-running"] },
  { group: "paired", words: ["on-accent", "on-inverse"] },
];

export const GRAMMAR =
  "color / <surface | text | border | affordance> / <purpose> [/ state]";

/** Fixed order, so there is only one correct spelling. */
export const GRAMMAR_EXAMPLES = {
  legal: ["bg-surface-panel", "text-standard", "bg-affordance-subtle-hover"],
  illegal: ["bg-chrome-hover-glass", "bg-hover-chrome"],
};

/** Runs per change, by whoever needs the value. Nothing here needs permission. */
export const GROWTH_PROCEDURE = [
  "Search the role list by intent, not by colour.",
  "A state of an existing role — add the -hover, -selected, or -disabled sibling with both values.",
  "A material variant of an existing role — add the -glass sibling with both values and its blur token.",
  "A new role using existing words — add the name, both values, a one-sentence description, and an owner.",
  "A new hue — generate its ramp, add roles pointing at steps. Never a literal.",
  "A new vocabulary word — allowed, but it is the thing the audit reports on its own line, so use an existing word if one fits.",
  "Never write a raw value. If nothing above applies, say so rather than reaching for a literal.",
];

/* ============================================================
   TYPOGRAPHY
   ============================================================ */

/** A public type role. Carries its whole setting, because size, line height,
 *  tracking, and weight are one decision rather than four. */
export interface TypeRole {
  /** The Tailwind class, e.g. `text-body`. */
  token: string;
  /** Semantic role represented by this utility. */
  pointsAt: string;
  /** Rendered size at the default preference and zoom, for display only —
   *  never a value a component may use. */
  size: string;
  lineHeight: string;
  tracking: string;
  weight: string;
  /** One sentence: when to use this. */
  use: string;
  status: TokenStatus;
  /** Set when the role renders in the mono face. */
  mono?: boolean;
}

/** Ordered loudest to quietest, which is also the order they are chosen in. */
export const TYPE_ROLES: TypeRole[] = [
  {
    token: "text-display",
    pointsAt: "display/hero",
    size: "56px",
    lineHeight: "56px",
    tracking: "-0.04em",
    weight: "400",
    use: "Expressive welcome or hero.",
    status: "core",
  },
  {
    token: "text-title",
    pointsAt: "display/page-title",
    size: "32px",
    lineHeight: "32px",
    tracking: "-0.015em",
    weight: "500",
    use: "Screen title.",
    status: "core",
  },
  {
    token: "text-heading",
    pointsAt: "display/section-title",
    size: "24px",
    lineHeight: "24px",
    tracking: "-0.0075em",
    weight: "500",
    use: "Content section title.",
    status: "core",
  },
  {
    token: "text-body-lg",
    pointsAt: "body/body-large",
    size: "20px",
    lineHeight: "28px",
    tracking: "-0.01em",
    weight: "400",
    use: "Lead paragraph.",
    status: "core",
  },
  {
    token: "text-body",
    pointsAt: "body/body-medium",
    size: "16px",
    lineHeight: "24px",
    tracking: "-0.005em",
    weight: "400",
    use: "Reading text and messages.",
    status: "core",
  },
  {
    token: "text-body-sm",
    pointsAt: "body/body-small",
    size: "14px",
    lineHeight: "20px",
    tracking: "-0.0025em",
    weight: "400",
    use: "Supporting or dense reading text.",
    status: "core",
  },
  {
    token: "text-label",
    pointsAt: "body/label-medium",
    size: "16px",
    lineHeight: "24px",
    tracking: "0em",
    weight: "500",
    use: "Controls and panel titles.",
    status: "core",
  },
  {
    token: "text-label-sm",
    pointsAt: "body/label-small",
    size: "14px",
    lineHeight: "20px",
    tracking: "0.0025em",
    weight: "500",
    use: "Compact controls and row labels.",
    status: "core",
  },
  {
    token: "text-caption",
    pointsAt: "detail/caption",
    size: "12px",
    lineHeight: "16px",
    tracking: "0.0133em",
    weight: "400",
    use: "Timestamps and metadata.",
    status: "core",
  },
  {
    token: "text-mono-lg",
    pointsAt: "detail/body-xsmall",
    size: "12px",
    lineHeight: "16px",
    tracking: "0.03em",
    weight: "400",
    use: "Compatibility alias for text-mono; use text-mono in new code.",
    status: "core",
    mono: true,
  },
  {
    token: "text-mono",
    pointsAt: "detail/body-xsmall",
    size: "12px",
    lineHeight: "16px",
    tracking: "0.03em",
    weight: "400",
    use: "Code and identifiers.",
    status: "core",
    mono: true,
  },
  {
    token: "text-mono-sm",
    pointsAt: "detail/body-xsmall",
    size: "12px",
    lineHeight: "16px",
    tracking: "0.03em",
    weight: "400",
    use: "Compatibility alias for text-mono; use text-mono in new code.",
    status: "core",
    mono: true,
  },
];

/** Font families used by the type roles. */
export const TYPE_FAMILIES = [
  {
    token: "font-sans",
    name: "Inter Variable",
    use: "Interface, labels and reading text.",
  },
  {
    token: "font-mono",
    name: "JetBrains Mono",
    use: "Code, keys and identifiers, set in the xsmall detail role at 12/16.",
  },
];

/** Source for the primitive ladder and resolved roles displayed below. */
export const TYPE_SOURCE =
  "https://github.com/block/buzz-app/blob/main/src/shared/design-system/styles/typography.css";

/** Active size primitives, with xsmall sharing the 12px step. */
export const TYPE_RAMPS = [
  {
    id: "size",
    name: "Size",
    description:
      "Thirteen size steps. Caption and xsmall detail both use 12px, with separate semantic tokens so each can evolve independently. Values shown at 100% text size.",
    steps: [
      {
        step: 12,
        value: "12px",
        job: "caption and xsmall detail",
      },
      {
        step: 14,
        value: "14px",
        job: "small body and labels",
      },
      {
        step: 16,
        value: "16px",
        job: "body and labels",
      },
      {
        step: 18,
        value: "18px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 20,
        value: "20px",
        job: "large body",
      },
      {
        step: 24,
        value: "24px",
        job: "section title",
      },
      {
        step: 28,
        value: "28px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 32,
        value: "32px",
        job: "page title",
      },
      {
        step: 36,
        value: "36px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 44,
        value: "44px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 56,
        value: "56px",
        job: "hero",
      },
      {
        step: 72,
        value: "72px",
        job: "Primitive only; no role assigned.",
      },
      {
        step: 96,
        value: "96px",
        job: "Primitive only; no role assigned.",
      },
    ],
  },
  {
    id: "weight",
    name: "Weight",
    description: "400 for reading, 500 for labels and structure.",
    steps: [
      { step: 400, job: "reading", value: "400" },
      { step: 500, job: "structure", value: "500" },
    ],
  },
];

export const SPACE = [
  {
    step: 0.5,
    variable: "--space-half",
    value: "2px",
    use: "Compact control inset.",
  },
  {
    step: 1.5,
    variable: "--space-1h",
    value: "6px",
    use: "Compact control gap.",
  },
  {
    step: 1,
    variable: "--space-1",
    value: "4px",
    use: "Tight optical separation inside a control.",
  },
  {
    step: 2,
    variable: "--space-2",
    value: "8px",
    use: "The panel gap and default gap between related items.",
  },
  {
    step: 3,
    variable: "--space-3",
    value: "12px",
    use: "The horizontal inset inside rows and compact controls.",
  },
  {
    step: 4,
    variable: "--space-4",
    value: "16px",
    use: "The workspace edge and ordinary content inset.",
  },
  {
    step: 5,
    variable: "--space-5",
    value: "20px",
    use: "The inset of a full panel header or reading surface.",
  },
  {
    step: 6,
    variable: "--space-6",
    value: "24px",
    use: "Separation between distinct content groups.",
  },
  { step: 8, variable: "--space-8", value: "32px", use: "Content groups." },
  { step: 16, variable: "--space-16", value: "64px", use: "Page sections." },
];

export const SPACE_ROLES = [
  {
    token: "space-page-section-gap",
    variable: "--space-page-section-gap",
    pointsAt: "space 16",
    use: "Separation between page sections.",
  },
  {
    token: "space-workspace-inset",
    variable: "--space-workspace-inset",
    pointsAt: "space 4",
    use: "The distance between the window edge and its panels.",
  },
  {
    token: "space-panel-gap",
    variable: "--space-panel-gap",
    pointsAt: "space 2",
    use: "The seam between independently movable panels.",
  },
  {
    token: "space-panel-inset",
    variable: "--space-panel-inset",
    pointsAt: "space 6",
    use: "The horizontal inset inside a full panel.",
  },
  {
    token: "space-control-inset",
    variable: "--space-control-inset",
    pointsAt: "space 4",
    use: "The horizontal inset inside controls and navigation rows.",
  },
  {
    token: "space-row-gap",
    variable: "--space-row-gap",
    pointsAt: "space 2",
    use: "The gap between an icon, label, and trailing metadata in one row.",
  },
  {
    token: "space-section-gap",
    variable: "--space-section-gap",
    pointsAt: "space 8",
    use: "The gap between adjacent navigator sections. Larger than the 1px between rows inside one, because that difference is the only thing saying where a group ends.",
  },
];

export const RADII = [
  {
    token: "radius-row",
    variable: "--radius-row",
    value: "10px",
    use: "Dense navigator rows and compact selected regions.",
  },
  {
    token: "radius-control",
    variable: "--radius-control",
    value: "8px",
    use: "Inputs and compact icon controls. Text buttons use radius-pill.",
  },
  {
    token: "radius-panel",
    variable: "--radius-panel",
    value: "24px",
    use: "Every major workspace panel.",
  },
  {
    token: "radius-pill",
    variable: "--radius-pill",
    value: "round",
    use: "Pills, avatars, and fully circular controls.",
  },
];

export const MOTION = [
  {
    token: "duration-fast",
    variable: "--duration-fast",
    value: "120ms",
    use: "A hover affordance appearing or disappearing.",
  },
  {
    token: "duration-state",
    variable: "--duration-state",
    value: "150ms",
    use: "A colour or opacity state changing in place.",
  },
  {
    token: "duration-settle",
    variable: "--duration-settle",
    value: "220ms",
    use: "A tab indicator or released panel settling into place.",
  },
  {
    token: "easing-state",
    variable: "--easing-state",
    value: "ease",
    use: "Small state changes that do not move geometry.",
  },
  {
    token: "easing-settle",
    variable: "--easing-settle",
    value: "cubic-bezier(.645,.045,.355,1)",
    use: "Geometry settling after a deliberate selection or release.",
  },
];

export const ELEVATION = [
  {
    token: "shadow-xs",
    variable: "--shadow-xs",
    use: "The default lift: a selected pill, a small raised control.",
  },
  {
    token: "shadow-sm",
    variable: "--shadow-sm",
    use: "A floating surface: menus, dialogs, popovers.",
  },
];

export const BLUR = [
  { token: "blur-sm", variable: "--blur-sm", value: "8px" },
  { token: "blur-md", variable: "--blur-md", value: "16px" },
  { token: "blur-lg", variable: "--blur-lg", value: "32px" },
];

/** The entire exception list. Everything else points at a ramp step. */
export const EXCEPTIONS = [
  {
    name: "text-on-accent, text-on-inverse, and the four status pairings",
    why: "Computed from their fill's lightness rather than fixed, because white is readable on a blue or purple fill and unreadable on yellow or lime. This is what keeps a free choice of accent hue from becoming a contrast lottery.",
  },
  {
    name: "--rim-lit, --rim-shade",
    why: "The glass rim is a directional light effect, not a solid line. It is not on the glass ramp — that is a ramp of fills, and in dark mode the fill is translucent near-black while the rim stays translucent white. It is not one of the numbered gradients either: those are background treatments, this is a material detail.",
  },
  {
    name: "backdrop treatments and gradient-1…4, texture-dots",
    why: "Not colours in the ramp sense. A named backdrop treatment is a complete visual composition; gradient-1…4 pair one light scene and one dark scene for a stable appearance choice.",
  },
];
