import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tokens = readFileSync(
  join(root, "src/shared/design-system/styles/tokens.css"),
  "utf8",
);

// Exercise the real CLI against isolated stylesheet mutations. No repository
// files are changed, and a green status proves the guard actually ran.
function check(css) {
  const fixture = mkdtempSync(join(tmpdir(), "buzz-contrast-"));
  try {
    mkdirSync(join(fixture, "scripts/design-system"), { recursive: true });
    mkdirSync(join(fixture, "src/shared/design-system/styles"), {
      recursive: true,
    });
    for (const name of ["check-contrast.mjs", "apca.mjs"])
      copyFileSync(
        join(root, "scripts/design-system", name),
        join(fixture, "scripts/design-system", name),
      );
    writeFileSync(
      join(fixture, "src/shared/design-system/styles/tokens.css"),
      css,
    );
    const result = spawnSync(
      process.execPath,
      [join(fixture, "scripts/design-system/check-contrast.mjs")],
      { encoding: "utf8" },
    );
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("semantic contrast contract", () => {
  it("checks the current text and state-boundary pairs in both modes", () => {
    const result = check(tokens);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("text and control/state boundaries clear");
  });

  it.each(["danger", "warning"])(
    "rejects the former low-contrast %s boundary",
    (role) => {
      const hue = role === "danger" ? "red" : "amber";
      const result = check(
        tokens.replaceAll(
          new RegExp(`--border-${role}: var\\(--${hue}-\\d+\\);`, "g"),
          `--border-${role}: var(--${hue}-8);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `light: --border-${role} on --surface-panel`,
      );
      expect(result.output).toContain(
        `dark: --border-${role} on --surface-popover`,
      );
    },
  );

  it.each([
    ["online", "green"],
    ["avatar-online-border", "green"],
    ["avatar-away-border", "amber"],
    ["offline", "neutral"],
  ])("checks %s status on supported surfaces in both modes", (role, hue) => {
    const result = check(
      tokens.replaceAll(
        new RegExp(`--status-${role}: var\\(--${hue}-\\d+\\);`, "g"),
        `--status-${role}: var(--${hue}-5);`,
      ),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      `light: --status-${role} on --surface-panel`,
    );
    expect(result.output).toContain(
      `dark: --status-${role} on --surface-popover`,
    );
  });

  it.each([
    ["online", "green"],
    ["away", "amber"],
  ])(
    "rejects a %s outline that disappears on hover or selection",
    (role, hue) => {
      const result = check(
        tokens.replaceAll(
          `--status-avatar-${role}-border: var(--${hue}-11);`,
          `--status-avatar-${role}-border: var(--${hue}-10);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `light: --status-avatar-${role}-border on --affordance-selected`,
      );
    },
  );

  it.each(["warning", "success", "accent"])(
    "checks %s text against its semantic fill, not only the palette",
    (role) => {
      const hue = { warning: "amber", success: "green", accent: "purple" }[
        role
      ];
      const result = check(
        tokens.replaceAll(
          `--affordance-${role}: var(--${hue}-3);`,
          `--affordance-${role}: var(--${hue}-9);`,
        ),
      );
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(`--text-${role}`);
      expect(result.output).toContain(`on --affordance-${role}`);
    },
  );
});
