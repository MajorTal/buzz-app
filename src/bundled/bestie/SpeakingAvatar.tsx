import { useEffect, useRef } from "react";
import styles from "./Bestie.module.css";

export function SpeakingAvatar({
  analyser,
}: {
  analyser: AnalyserNode | null;
}) {
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = image.current;
    if (!element) return;
    const reset = () => {
      element.style.opacity = "1";
      element.style.transform = "translateY(0px) rotate(0deg) scale(1)";
    };
    reset();
    if (!analyser) return;
    const samples = new Float32Array(analyser.fftSize);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous = performance.now();
    let level = 0;
    let velocity = 0;
    let tilt = 0;
    let tiltVelocity = 0;
    let direction = -1;
    let quietFor = 1;
    const draw = (now: number) => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, sample) => sum + sample * sample, 0) /
          samples.length,
      );
      const target = rms < 0.002 ? 0 : Math.min(1, Math.sqrt(rms * 4));
      // Change the lean only at a new phrase, never on a repeating idle loop.
      // Small springs keep momentum through syllables and settle during pauses.
      let elapsed = Math.min((now - previous) / 1000, 0.032);
      previous = now;
      if (target === 0) quietFor += elapsed;
      else {
        if (quietFor >= 0.18) direction *= -1;
        quietFor = 0;
      }
      const tiltTarget = target * direction;
      // Cap elapsed time after backgrounding and integrate in small steps.
      while (elapsed > 0) {
        const step = Math.min(elapsed, 1 / 120);
        velocity += (100 * (target - level) - 10 * velocity) * step;
        level += velocity * step;
        tiltVelocity += (100 * (tiltTarget - tilt) - 10 * tiltVelocity) * step;
        tilt += tiltVelocity * step;
        elapsed -= step;
      }
      if (
        target === 0 &&
        Math.abs(level) < 0.001 &&
        Math.abs(velocity) < 0.001 &&
        Math.abs(tilt) < 0.001 &&
        Math.abs(tiltVelocity) < 0.001
      ) {
        level = velocity = tilt = tiltVelocity = 0;
      }
      element.style.opacity = reduced.matches
        ? String(0.94 + target * 0.06)
        : "1";
      element.style.transform = reduced.matches
        ? "translateY(0px) rotate(0deg) scale(1)"
        : `translateY(${-level * 3}px) rotate(${tilt * 1.8}deg) scale(${1 + level * 0.025})`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      reset();
    };
  }, [analyser]);
  return (
    <div className={styles.avatar}>
      <img ref={image} src="/bestie.png" alt="Bestie" />
    </div>
  );
}
