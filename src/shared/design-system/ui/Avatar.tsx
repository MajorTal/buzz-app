import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { useEffect, useState } from "react";

type AvatarSize = "small" | "default" | "large";
type ImageStatus = "loading" | "loaded" | "failed";

function AvatarArtwork({ src, fallback }: { src: string; fallback: string }) {
  const [status, setStatus] = useState<ImageStatus>("loading");
  const [showFallback, setShowFallback] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShowFallback(true), 150);
    return () => window.clearTimeout(timer);
  }, []);
  if (status === "failed") return <span aria-hidden="true">{fallback}</span>;
  return (
    <>
      <img
        src={src}
        data-loaded={status === "loaded" ? "true" : undefined}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("failed")}
      />
      {status === "loading" && showFallback ? (
        <span aria-hidden="true">{fallback}</span>
      ) : null}
    </>
  );
}

export function Avatar({
  src,
  alt,
  fallback,
  size = "default",
}: {
  src?: string | null;
  alt: string;
  fallback: string;
  size?: AvatarSize;
}) {
  const initial = fallback.slice(0, 1).toUpperCase();
  return (
    <BaseAvatar.Root
      data-buzz-ui=""
      className="buzz-avatar"
      data-size={size}
      role="img"
      aria-label={alt}
    >
      {src ? (
        <AvatarArtwork key={src} src={src} fallback={initial} />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </BaseAvatar.Root>
  );
}
