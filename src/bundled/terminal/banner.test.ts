import { describe, expect, it } from "vitest";
import { buildTerminalBanner } from "./banner";

describe("compact terminal wordmark", () => {
  it.each([
    [1200, 560],
    [360, 180],
    [280, 78],
  ])("fits the complete wordmark at %ix%i", (width, height) => {
    const banner = buildTerminalBanner(width, height);
    expect(banner).not.toBeNull();
    const ink = banner?.cells.filter((cell) => cell.ink) ?? [];
    expect(ink.length).toBe(71 + 58 + 47 * 2); // b + u + z + z, no clipped cells
    for (const cell of ink) {
      expect(cell.cx).toBeGreaterThan(0);
      expect(cell.cx).toBeLessThan(width);
      expect(cell.cy).toBeGreaterThan(0);
      expect(cell.cy).toBeLessThan(height);
    }
  });
  it("does not allocate a field for a zero-sized host", () => {
    expect(buildTerminalBanner(0, 0)).toBeNull();
  });
  it("bounds the decorative grid in very large windows", () => {
    expect(buildTerminalBanner(8000, 8000)?.cells.length).toBeLessThanOrEqual(
      160 * 80,
    );
  });
});
