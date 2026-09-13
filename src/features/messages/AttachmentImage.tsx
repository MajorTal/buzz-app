import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../relay/contracts";
import { validatedBlurhash } from "../relay/blurhash";
import { BLURHASH_SIZE, paintBlurhash } from "./blurhash";
import styles from "./Messages.module.css";

export function AttachmentImage({
  attachment,
  url,
  source,
  onOpenLink,
}: {
  attachment: Attachment;
  url: string;
  source: string;
  onOpenLink(url: string): boolean;
}) {
  return (
    <a
      className={styles.attachmentImage}
      style={
        attachment.dimensions
          ? {
              width: Math.min(
                360,
                attachment.dimensions.width,
                (320 * attachment.dimensions.width) /
                  attachment.dimensions.height,
              ),
              aspectRatio: `${attachment.dimensions.width} / ${attachment.dimensions.height}`,
            }
          : undefined
      }
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label="Open image attachment"
      onClick={(event) => {
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          onOpenLink(url)
        )
          event.preventDefault();
      }}
    >
      {/* Retargeting retires both the DOM pixels and all pending callbacks before
          the new source can paint. Session switches also remount the workspace. */}
      <ImagePixels
        key={JSON.stringify([source, attachment.blurhash])}
        source={source}
        blurhash={attachment.blurhash}
      />
    </a>
  );
}

function ImagePixels({
  source,
  blurhash,
}: {
  source: string;
  blurhash: string | undefined;
}) {
  const image = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const hash = validatedBlurhash(blurhash);
  useEffect(() => {
    const original = image.current;
    if (!original) return;
    let active = true;
    let decoded = false;
    let painted = false;
    let decoding = false;
    let observer: IntersectionObserver | undefined;
    const loaded = async () => {
      if (!active || decoding || decoded || !original.naturalWidth) return;
      decoding = true;
      try {
        await original.decode();
        if (!active) return;
        decoded = true;
        observer?.disconnect();
        setReady(true);
      } catch {
        // Keep the blur preview on original failure, including decode rejection.
      } finally {
        decoding = false;
      }
    };
    original.addEventListener("load", loaded);
    if (original.complete) void loaded();
    const preview = canvas.current;
    if (hash && preview && typeof IntersectionObserver !== "undefined") {
      // Original requests keep native loading="lazy". Only preview CPU work is
      // visibility-gated, including nonvirtualized thread rows. No new scheduler.
      observer = new IntersectionObserver((entries) => {
        if (
          !active ||
          decoded ||
          painted ||
          !entries.some((entry) => entry.isIntersecting)
        )
          return;
        observer?.disconnect();
        painted = true;
        paintBlurhash(preview, hash);
      });
      observer.observe(preview);
    }
    // Without IntersectionObserver, retain the old placeholder rather than
    // eagerly decode every mounted thread attachment.
    return () => {
      active = false;
      original.removeEventListener("load", loaded);
      observer?.disconnect();
    };
  }, [hash]);
  return (
    <>
      {hash && !ready && (
        <canvas
          ref={canvas}
          width={BLURHASH_SIZE}
          height={BLURHASH_SIZE}
          tabIndex={-1}
          aria-hidden="true"
        />
      )}
      <img
        ref={image}
        src={source}
        alt=""
        loading="lazy"
        style={{ visibility: ready ? "visible" : "hidden" }}
      />
    </>
  );
}
