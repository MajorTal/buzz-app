/** Compact three-cell strokes on a staggered hexagon field. Decoration only. */
const WORDMARK = Array.from({ length: 12 }, (_, y) =>
  [..."buzz"].flatMap((letter, index) => [
    ...Array.from({ length: 8 }, (_, x) => {
      if (y < 3) return letter === "b" && x < 3;
      const bar = y < 5 || y >= 10;
      if (letter === "b") return x < 3 || x >= 5 || bar;
      if (letter === "u") return x < 3 || x >= 5 || y >= 10;
      const diagonal = Math.round(5 * (1 - (y - 3) / 8));
      return bar || (x >= diagonal && x < diagonal + 3);
    }),
    ...(index < 3 ? [false, false] : []),
  ]),
);

export function buildTerminalBanner(width: number, height: number) {
  const cell = Math.min(
    12,
    (width - 24) / 40,
    (height - 24) / ((16 * Math.sqrt(3)) / 2),
  );
  if (cell < 1) return null;
  const rowHeight = (cell * Math.sqrt(3)) / 2;
  const columns = Math.min(160, Math.floor((width - 24) / cell));
  const rows = Math.min(80, Math.floor((height - 24) / rowHeight));
  const left = Math.floor((columns - 38) / 2);
  const top = Math.floor((rows - 12) / 2);
  const ox = (width - columns * cell) / 2;
  const oy = (height - rows * rowHeight) / 2;
  const cells = Array.from({ length: columns * rows }, (_, index) => {
    const x = index % columns,
      y = Math.floor(index / columns);
    return {
      x,
      y,
      cx: ox + (x + 0.25 + (y % 2) * 0.5) * cell,
      cy: oy + (y + 0.5) * rowHeight,
      ink: WORDMARK[y - top]?.[x - left] ?? false,
      field:
        Math.sin(x * 0.13 + y * 0.085) * 1.4 +
        Math.cos(y * 0.24 - x * 0.07) +
        Math.sin(x * 0.055 - y * 0.19) * 0.7,
      seed: Math.abs((Math.sin(x * 127.1 + y * 311.7) * 43758.5453) % 1),
      edge: Math.min(
        1,
        (Math.min(x, columns - 1 - x, y * 1.4, (rows - 1 - y) * 1.4) + 1) / 4,
      ),
    };
  });
  return { width, height, cell, cells };
}

type Banner = NonNullable<ReturnType<typeof buildTerminalBanner>>;
export type BannerPointer = { x: number; y: number; strength: number };
export type BannerPulse = { x: number; y: number; at: number };
export type BannerColors = {
  surface: string;
  ink: readonly string[];
  field: readonly string[];
  opacity: number;
};

/** Resolve CSS colors through the browser, including short hex and named colors. */
export function bannerColors(element: HTMLElement): BannerColors {
  const css = getComputedStyle(element);
  const swatch = document.createElement("canvas");
  swatch.width = swatch.height = 1;
  const context = swatch.getContext("2d", { willReadFrequently: true });
  const ramp = (start: string, end: string) => {
    if (!context) return [start];
    return Array.from({ length: 64 }, (_, index) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = `color-mix(in srgb, ${start}, ${end} ${(index / 63) * 100}%)`;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    });
  };
  const role = (name: string) => css.getPropertyValue(name).trim();
  return {
    surface: role("--surface-panel"),
    ink: ramp(role("--splash-start"), role("--splash-end")),
    field: ramp(role("--border-standard"), role("--border-prominent")),
    opacity: Number(role("--splash-field-opacity")),
  };
}

export function drawTerminalBanner(
  context: CanvasRenderingContext2D,
  banner: Banner,
  colors: BannerColors,
  elapsed: number,
  pointer: BannerPointer,
  pulses: readonly BannerPulse[],
) {
  const { width, height, cell, cells } = banner;
  const time = elapsed / 1000;
  context.clearRect(0, 0, width, height);
  context.fillStyle = colors.surface;
  context.fillRect(0, 0, width, height);
  for (const p of cells) {
    const distance = Math.hypot(
      (p.cx - pointer.x * width) / cell,
      (p.cy - pointer.y * height) / cell,
    );
    let pulseWave = 0;
    for (const pulse of pulses) {
      const age = (elapsed - pulse.at) / 1200;
      const radius = Math.hypot(
        (p.cx - pulse.x * width) / cell,
        (p.cy - pulse.y * height) / cell,
      );
      const ring = (radius - age * 30) / 3;
      pulseWave +=
        Math.cos(ring) *
        Math.exp(-ring * ring * 0.5) *
        Math.sin(Math.PI * age) *
        (1 - age) *
        0.3;
    }
    const ripple =
      Math.sin(distance * 0.65 - time * 3) *
        Math.exp(-distance / 18) *
        pointer.strength *
        0.65 +
      Math.max(-0.2, Math.min(0.2, pulseWave));
    const wave =
      p.field + Math.sin(p.y * 0.17 + time * 0.36) * 0.55 + ripple * 2.4;
    const phase = wave * 1.25 + time * 0.22 + 4.5;
    const blend = ((phase % 2) + 2) % 2;
    const ramp = p.ink ? colors.ink : colors.field;
    context.strokeStyle =
      ramp[Math.round((blend > 1 ? 2 - blend : blend) * (ramp.length - 1))] ??
      colors.surface;
    const neutral =
      Math.min(
        1,
        (0.3 + (0.38 * (wave + 3.6)) / 7.2 + Math.max(0, ripple) * 0.22) / 0.65,
      ) * colors.opacity;
    context.globalAlpha = Math.max(
      0,
      Math.min(1, (p.ink ? 0.92 * (1 + ripple * 0.35) : neutral) * p.edge),
    );
    context.lineWidth = 0.8 + Math.max(0, ripple) * 0.65;
    // A quarter-cell gap between neighboring hexagon faces.
    const size = ((cell * 0.75 * 2) / Math.sqrt(3)) * (1 + ripple * 0.12);
    const x = p.cx - size / 2,
      y = p.cy - size / 2;
    const hatch = Math.sin(wave * 2 + time * 0.4 + p.seed * 0.45) > 0.3;
    context.setLineDash(hatch ? [] : [1, 1.6]);
    context.beginPath();
    for (let corner = 0; corner < 6; corner++) {
      const angle = (corner * Math.PI) / 3 - Math.PI / 2;
      const hx = p.cx + (Math.cos(angle) * size) / 2,
        hy = p.cy + (Math.sin(angle) * size) / 2;
      if (corner === 0) context.moveTo(hx, hy);
      else context.lineTo(hx, hy);
    }
    context.closePath();
    context.stroke();
    if (hatch) {
      context.save();
      context.clip();
      context.setLineDash([]);
      context.beginPath();
      for (let d = 3; d < size * 2; d += 3) {
        context.moveTo(x + Math.max(0, d - size), y + Math.min(size, d));
        context.lineTo(x + Math.min(size, d), y + Math.max(0, d - size));
      }
      context.stroke();
      context.restore();
    }
  }
  context.globalAlpha = 1;
}
