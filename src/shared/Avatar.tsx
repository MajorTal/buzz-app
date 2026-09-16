import { useState } from "react";

/** Caller resolves private relay media through the current session. */
export function Avatar({
  name,
  src,
  className = "",
}: {
  name: string;
  src?: string | undefined;
  className?: string;
}) {
  const [failed, setFailed] = useState<string>();
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase() || "?";
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center overflow-hidden rounded-2xl bg-neutral-3 font-semibold text-secondary ${className}`}
      aria-hidden="true"
    >
      {initials}
      {src && src !== failed && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}
