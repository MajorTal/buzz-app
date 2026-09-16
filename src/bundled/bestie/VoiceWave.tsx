import { useEffect, useRef, useState } from "react";
import styles from "./Bestie.module.css";

const barHeight = 40;
const barPitch = 5; // 2px bars with 3px gaps.
const clip = (height: number) =>
  `inset(${(barHeight - height) / 2}px 0 round 1px)`;

export function VoiceWave({
  analyser,
  muted,
}: {
  analyser: AnalyserNode | null;
  muted: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const bars = Array.from({ length: count }, (_, index) => index);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setCount(
          Math.max(0, Math.floor((entry.contentRect.width + 3) / barPitch)),
        );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const layers = Array.from(ref.current?.children ?? []).map(
      (layer) => Array.from(layer.children) as HTMLElement[],
    );
    const reset = () => {
      for (const layer of layers) {
        for (const element of layer) {
          element.style.clipPath = clip(2);
          element.style.opacity = "1";
        }
      }
    };
    reset();
    if (!analyser || muted || !count) return;
    const data = new Float32Array(analyser.fftSize);
    const history = new Float32Array(count);
    const amplitudes = new Float32Array(count);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous = performance.now();
    let sampled = 0;
    let level = 0;
    const draw = (now: number) => {
      const elapsed = Math.min(now - previous, 64);
      previous = now;
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(
        data.reduce((sum, value) => sum + value * value, 0) / data.length,
      );
      const target = rms < 0.003 ? 0 : Math.min(1, rms * 5);
      level +=
        (target - level) *
        (1 - Math.exp(-elapsed / (target > level ? 45 : 140)));
      // A short volume history adds shape; the live level gives immediate feedback.
      if (now - sampled >= 1000 / 30) {
        sampled = now;
        history.copyWithin(0, 1);
        history[history.length - 1] = level;
      }
      for (let index = 0; index < count; index++) {
        const taper =
          count === 1 ? 1 : Math.sin((Math.PI * index) / (count - 1)) ** 1.5;
        const amplitude = (level * 0.6 + (history[index] ?? 0) * 0.4) * taper;
        const smooth =
          (amplitudes[index] ?? 0) +
          (amplitude - (amplitudes[index] ?? 0)) *
            (1 - Math.exp(-elapsed / 60));
        amplitudes[index] = smooth;
        for (const layer of layers) {
          const element = layer[index];
          if (!element) continue;
          element.style.clipPath = clip(
            reduced.matches ? 6 : 2 + smooth * (barHeight - 2),
          );
          element.style.opacity = String(
            reduced.matches
              ? 0.35 + level * 0.65
              : 0.45 + Math.min(1, level * 2) * 0.55,
          );
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      reset();
    };
  }, [analyser, muted, count]);
  return (
    <div
      ref={ref}
      className={styles.wave}
      role="img"
      aria-label={muted ? "Microphone muted" : "Microphone activity"}
    >
      <div className={styles.waveTrail} aria-hidden="true">
        {bars.map((index) => (
          <span key={index} />
        ))}
      </div>
      <div className={styles.waveFront} aria-hidden="true">
        {bars.map((index) => (
          <span key={index} />
        ))}
      </div>
    </div>
  );
}
