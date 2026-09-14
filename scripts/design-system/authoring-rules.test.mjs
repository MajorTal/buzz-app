import { describe, expect, it } from "vitest";
import { authoringFindings, compareBaseline } from "./authoring-rules.mjs";
import { earnedColorFailures } from "./earned-colors.mjs";

const css = (source) =>
  authoringFindings("src/features/example/Example.css", source);
const jsx = (source) =>
  authoringFindings("src/features/example/Example.tsx", source);

describe("color decision evidence", () => {
  it("accepts a same-step approved pattern and an established text rule", () => {
    expect(
      earnedColorFailures(`:root {
      /* @earned pattern: Morgan approved the recurring callout treatment. */
      --bg-callout: var(--purple-3);
      /* @earned rule: Primary reading level. */
      --text-primary: var(--neutral-12);
    } .dark { --bg-callout: var(--purple-3); }`),
    ).toEqual([]);
  });
  it("accepts a mismatched pairing, but not a false modes label", () => {
    const source = `:root { /* @earned modes: Raised in both contexts. */ --bg-new: var(--neutral-1); }`;
    expect(
      earnedColorFailures(`${source} .dark { --bg-new: var(--neutral-2); }`),
    ).toEqual([]);
    expect(
      earnedColorFailures(`${source} .dark { --bg-new: var(--neutral-1); }`),
    ).toHaveLength(1);
  });
  it("asks for the decision instead of recommending silent demotion", () => {
    expect(
      earnedColorFailures(":root { --bg-callout: var(--purple-3); }")[0],
    ).toContain("Preserve an approved name");
  });
  it("rejects empty, misplaced and missing-default annotations", () => {
    expect(
      earnedColorFailures(
        ":root { /* @earned pattern: */ --bg-new: var(--purple-3); }",
      ),
    ).toHaveLength(1);
    expect(
      earnedColorFailures(":root { /* @earned rule: orphan */ }"),
    ).toHaveLength(1);
    expect(
      earnedColorFailures(".dark { --bg-new: var(--purple-3); }"),
    ).toHaveLength(1);
  });
});

describe("authoring guard", () => {
  it.each([
    ".dark .card { background: var(--neutral-2); }",
    '[data-color-mode="dark"] .card { color: var(--text-primary); }',
    "@media (prefers-color-scheme: dark) { .card { background: var(--neutral-2); } }",
    ".card { .dark & { background: var(--neutral-2); } }",
    ".dark .card { --fill: var(--neutral-2); }",
  ])("rejects local mode-specific paint: %s", (source) => {
    expect(css(source).some((finding) => finding.rule === "mode-color")).toBe(
      true,
    );
  });
  it("allows mode-neutral tokens, non-color mode rules and named translucency", () => {
    expect(
      css(
        ".card { background: var(--bg-panel); opacity: 0.5; } .dark .card { display: block; }",
      ),
    ).toEqual([]);
    expect(
      authoringFindings(
        "src/shared/design-system/styles/tokens.css",
        ":root { --purple-1: #ffffff; } .dark { --purple-1: #000000; }",
      ),
    ).toEqual([]);
  });
  it("detects literals and constructed colors but ignores CSS comments", () => {
    expect(
      css(
        "/* color: #fff */ .card { color: #fff; background: color-mix(in srgb, red, blue); }",
      ).filter((f) => f.rule === "local-color"),
    ).toHaveLength(2);
  });
  it("checks static JSX classes and inline styles", () => {
    expect(
      jsx(
        '<div className="dark:bg-neutral-2 text-sm bg-purple-3/50 bg-gray-100" style={{ color: "#fff" }} />',
      ).map((f) => f.rule),
    ).toEqual(
      expect.arrayContaining([
        "mode-color",
        "local-type",
        "color-opacity",
        "stock-color",
        "local-color",
      ]),
    );
    expect(
      jsx(
        '<div className={selected ? "dark:bg-neutral-2" : "bg-panel"} />',
      ).some((f) => f.rule === "mode-color"),
    ).toBe(true);
  });
  it("checks imported system components, including aliases, without confusing native layout", () => {
    expect(
      jsx(
        'import { Button as Action } from "../../shared/design-system/ui/Button"; const view = <Action className="ml-auto bg-purple-3 text-left" />;',
      ).filter((f) => f.rule === "component-restyle"),
    ).toEqual([
      { rule: "component-restyle", evidence: "Action | bg-purple-3" },
    ]);
    expect(jsx('<div className="bg-purple-3 text-body" />')).toEqual([]);
  });
  it("handles callback props and ignores JSX-looking prose", () => {
    expect(
      jsx(
        '<div onClick={() => act()} className="dark:bg-neutral-2 text-sm" />',
      ).map((f) => f.rule),
    ).toEqual(["mode-color", "local-type"]);
    expect(
      jsx("const example = '<div className=\"dark:bg-neutral-2\" />';"),
    ).toEqual([]);
    expect(
      jsx('<div className="bg-red-950" style={{ color: "red" }} />').map(
        (f) => f.rule,
      ),
    ).toEqual(["stock-color", "local-color"]);
    expect(
      css(".dark .card { border-radius: 8px; background-size: cover; }"),
    ).toEqual([]);
  });

  it("does not mistake text alignment for typography or numeric CSS for color", () => {
    expect(
      css(".card { width: 20px; font-weight: 600; color: inherit; }"),
    ).toEqual([]);
    expect(jsx('<div className="text-left text-body" />')).toEqual([]);
  });
  it("requires exact legacy occurrences, refuses stale entries and does not exempt files", () => {
    const finding = {
      file: "src/old.css",
      rule: "local-color",
      evidence: ".a | color: #fff",
    };
    const baseline = [
      { ...finding, count: 1, reason: "Existing unmigrated UI" },
    ];
    expect(compareBaseline([finding], baseline)).toEqual([]);
    expect(compareBaseline([finding, finding], baseline)).toHaveLength(1);
    expect(compareBaseline([], baseline)[0]).toContain("stale");
    expect(
      compareBaseline([{ ...finding, evidence: ".b | color: #fff" }], baseline),
    ).toHaveLength(2);
  });
});
