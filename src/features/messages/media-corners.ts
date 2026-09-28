// Uniform media corners use 60% smoothing, bounded by the shorter edge.
export function mediaCornerClip(
  width: number,
  height: number,
  radius: number,
  x = 0,
  y = 0,
) {
  const budget = Math.min(width, height) / 2;
  const r = Math.max(0, Math.min(radius, budget));
  const p = Math.min(1.6 * r, budget);
  const arc = Math.sin(Math.PI / 10) * r * Math.SQRT2;
  const distance = r * Math.tan((27 * Math.PI) / 360);
  const c = distance * Math.cos((27 * Math.PI) / 180);
  const d = c * Math.tan((27 * Math.PI) / 180);
  let b = (1.6 * r - arc - c - d) / 3;
  let a = 2 * b;
  if (1.6 * r > budget) {
    const available = budget - d - arc - c;
    b = Math.min(b, (5 * available) / 6);
    a = available - b;
  }
  // Retain matching commands at radius zero so the lightbox can interpolate.
  const path = `M ${x + p} ${y}
    L ${x + width - p} ${y}
    c ${a} 0 ${a + b} 0 ${a + b + c} ${d}
    a ${r} ${r} 0 0 1 ${arc} ${arc}
    c ${d} ${c} ${d} ${b + c} ${d} ${a + b + c}
    L ${x + width} ${y + height - p}
    c 0 ${a} 0 ${a + b} ${-d} ${a + b + c}
    a ${r} ${r} 0 0 1 ${-arc} ${arc}
    c ${-c} ${d} ${-(b + c)} ${d} ${-(a + b + c)} ${d}
    L ${x + p} ${y + height}
    c ${-a} 0 ${-(a + b)} 0 ${-(a + b + c)} ${-d}
    a ${r} ${r} 0 0 1 ${-arc} ${-arc}
    c ${-d} ${-c} ${-d} ${-(b + c)} ${-d} ${-(a + b + c)}
    L ${x} ${y + p}
    c 0 ${-a} 0 ${-(a + b)} ${d} ${-(a + b + c)}
    a ${r} ${r} 0 0 1 ${arc} ${-arc}
    c ${c} ${-d} ${b + c} ${-d} ${a + b + c} ${-d} Z`;
  return `path("${path.replace(/\s+/g, " ")}")`;
}
