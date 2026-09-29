import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./FadingLabel.module.css";

export function FadingLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  const label = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = label.current;
    if (!element) return;
    const measure = () =>
      setOverflowing(element.scrollWidth > element.clientWidth);
    measure();
    const mutations = new MutationObserver(measure);
    mutations.observe(element, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      mutations.disconnect();
      observer?.disconnect();
    };
  }, []);
  return (
    <span
      ref={label}
      className={`${styles.label} ${className ?? ""}`}
      data-overflowing={overflowing || undefined}
    >
      {children}
    </span>
  );
}
