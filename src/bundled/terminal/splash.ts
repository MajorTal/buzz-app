import {
  bannerColors,
  buildTerminalBanner,
  drawTerminalBanner,
  type BannerPulse,
} from "./banner";
import styles from "./Terminal.module.css";

/** One bounded welcome per screen; output continues beneath the decoration. */
export function createSplash(element: HTMLElement, focus: () => void) {
  let consumed = false;
  let overlay: HTMLDivElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | null = null;
  let banner: ReturnType<typeof buildTerminalBanner> = null;
  let colors: ReturnType<typeof bannerColors> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0,
    elapsed = 0,
    previous = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const hover = matchMedia("(hover: hover) and (pointer: fine)");
  const pointer = {
    x: 0.5,
    y: 0.5,
    targetX: 0.5,
    targetY: 0.5,
    strength: 0,
    inside: false,
  };
  let pulses: BannerPulse[] = [];
  const draw = () => {
    if (context && banner && colors)
      drawTerminalBanner(context, banner, colors, elapsed, pointer, pulses);
  };
  const tick = (now: number) => {
    frame = 0;
    if (!overlay || document.hidden || reduced.matches) return;
    const dt = previous ? Math.min(now - previous, 80) : 0;
    previous = now;
    elapsed += dt;
    const follow = 1 - Math.exp(-dt / 160);
    pointer.x += (pointer.targetX - pointer.x) * follow;
    pointer.y += (pointer.targetY - pointer.y) * follow;
    pointer.strength += ((pointer.inside ? 1 : 0) - pointer.strength) * follow;
    pulses = pulses.filter((pulse) => elapsed - pulse.at < 1200);
    draw();
    frame = requestAnimationFrame(tick);
  };
  const resume = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
    pointer.inside = false;
    pointer.strength = 0;
    pulses = [];
    draw();
    if (overlay && context && banner && !document.hidden && !reduced.matches)
      frame = requestAnimationFrame(tick);
  };
  const leave = () => {
    pointer.inside = false;
  };
  const dismiss = () => {
    consumed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("blur", leave);
    reduced.removeEventListener("change", resume);
    overlay?.remove();
    overlay = undefined;
    canvas = undefined;
    context = null;
    banner = null;
    colors = undefined;
    pulses = [];
  };
  const layout = () => {
    if (!overlay || !canvas || !context) return;
    const { clientWidth: width, clientHeight: height } = element;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    banner = buildTerminalBanner(width, height);
    colors = bannerColors(overlay);
    draw();
  };
  const position = (event: PointerEvent | MouseEvent) => {
    const rect = element.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };
  return {
    show() {
      if (
        consumed ||
        !element.isConnected ||
        !element.clientWidth ||
        !element.clientHeight
      )
        return;
      consumed = true;
      overlay = document.createElement("div");
      overlay.className = styles.splash ?? "";
      overlay.dataset.terminalSplash = "";
      overlay.setAttribute("aria-hidden", "true");
      canvas = document.createElement("canvas");
      canvas.className = styles.splashArt ?? "";
      canvas.textContent = "buzz";
      overlay.append(canvas);
      element.append(overlay);
      context = canvas.getContext("2d");
      // Keep xterm focused and do not turn artwork clicks into terminal mouse input.
      overlay.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        focus();
      });
      overlay.addEventListener("click", (event) => {
        if (reduced.matches) return;
        pulses = [...pulses.slice(-2), { ...position(event), at: elapsed }];
      });
      overlay.addEventListener("pointermove", (event) => {
        if (reduced.matches || !hover.matches || event.pointerType !== "mouse")
          return;
        const { x, y } = position(event);
        pointer.targetX = x;
        pointer.targetY = y;
        if (!pointer.inside && pointer.strength < 0.01) {
          pointer.x = x;
          pointer.y = y;
        }
        pointer.inside = true;
      });
      overlay.addEventListener("pointerleave", leave);
      overlay.addEventListener("pointercancel", leave);
      document.addEventListener("visibilitychange", resume);
      window.addEventListener("blur", leave);
      reduced.addEventListener("change", resume);
      layout();
      resume();
      timer = setTimeout(dismiss, 3000);
    },
    layout,
    dismiss,
  };
}
