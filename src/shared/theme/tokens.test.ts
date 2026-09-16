import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("src/shared/styles/tokens.css", "utf8");
const blocks = [...css.matchAll(/:root[^{}]*\{([^}]+)\}/g)].map((match) =>
  Object.fromEntries(
    [...(match[1] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2]?.trim(),
    ]),
  ),
);

// Resolve the real shared palette and host aliases in cascade order. The host
// no longer owns literal colors; a missing or cyclic alias must fail the test.
function resolvedPalette(mode: "light" | "dark") {
  const source = (
    readFileSync("src/shared/design-system/styles/tokens.css", "utf8") +
    "\n" +
    css
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const values: Record<string, string> = {};
  for (const [, selector = "", body = ""] of source.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    if (!selector.includes(":root") && !selector.includes(".dark")) continue;
    const dark =
      selector.includes('data-color-mode="dark"') || selector.includes(".dark");
    if (dark && mode !== "dark") continue;
    for (const [, name = "", value = ""] of body.matchAll(
      /(--[\w-]+):\s*([^;]+);/g,
    ))
      values[name] = value.trim();
  }
  const resolve = (name: string, seen = new Set<string>()): string => {
    if (seen.has(name)) throw new Error(`Cyclic token: ${name}`);
    seen.add(name);
    const value = values[name];
    if (!value) throw new Error(`Missing token: ${name}`);
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    return alias?.[1] ? resolve(alias[1], seen) : value;
  };
  return Object.fromEntries(
    Object.keys(values).map((name) => [name, resolve(name)]),
  );
}

function luminance(hex: string | undefined) {
  if (!hex) throw new Error("Missing contrast color");
  expect(hex).toMatch(/^#[\da-f]{6}$/i);
  const rgb = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb.reduce(
    (sum, value, i) => sum + value * ([0.2126, 0.7152, 0.0722][i] ?? 0),
    0,
  );
}
function contrast(a: string | undefined, b: string | undefined) {
  const x = luminance(a);
  const y = luminance(b);
  const low = Math.min(x, y);
  const high = Math.max(x, y);
  return (high + 0.05) / (low + 0.05);
}

it("both palettes define every color/elevation role, with shared radii", () => {
  expect(blocks).toHaveLength(2);
  expect(
    Object.keys(blocks[0])
      .filter((k) => !k.startsWith("--radius-"))
      .sort(),
  ).toEqual(Object.keys(blocks[1]).sort());
});

it.each([0, 1])(
  "palette %i has AA text/control token pairs (not a rendered audit)",
  (index) => {
    const t = resolvedPalette(index === 0 ? "light" : "dark");
    const textPairs: [string, string][] = [
      ...[
        "--surface",
        "--surface-accent",
        "--surface-elevated",
        "--surface-control",
        "--surface-input",
        "--surface-hover",
      ].flatMap((background) =>
        ["--text", "--text-muted"].map((foreground): [string, string] => [
          foreground,
          background,
        ]),
      ),
      ["--on-primary", "--primary"],
      ["--on-action", "--action"],
      ["--on-selected", "--selected"],
      ["--warning", "--warning-surface"],
      ["--success", "--success-surface"],
      ["--danger", "--surface"],
      ["--link", "--surface"],
    ];
    for (const [fg, bg] of textPairs)
      expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
        4.5,
      );
    for (const bg of [
      "--surface",
      "--surface-input",
      "--surface-elevated",
      "--selected",
    ]) {
      expect(
        contrast(t["--focus"], t[bg]),
        `focus on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
    }
    expect(
      contrast(t["--border-input"], t["--surface"]),
    ).toBeGreaterThanOrEqual(3);
  },
);
