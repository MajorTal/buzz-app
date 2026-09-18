import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Minus, Plus } from "lucide-react";
import type { Attachment } from "../relay/contracts";
import styles from "./Messages.module.css";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

type Point = Readonly<{ x: number; y: number }>;

type ImageReviewStageProps = {
  attachments: readonly Attachment[];
  selectedUrl: string;
  media(url: string): string | undefined;
  select(url: string): void;
};

function clamp(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value));
}

export function ImageReviewStage({
  attachments,
  selectedUrl,
  media,
  select,
}: ImageReviewStageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<
    { pointer: number; origin: Point; offset: Point } | undefined
  >(undefined);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const selectedIndex = Math.max(
    0,
    attachments.findIndex((item) => item.url === selectedUrl),
  );
  const selected = attachments[selectedIndex] ?? attachments[0];
  const source = selected ? media(selected.url) : undefined;
  const pannable = zoom > MIN_ZOOM;

  const panLimits = (nextZoom = zoom) => {
    const frame = stage.current?.getBoundingClientRect();
    const element = image.current;
    if (!frame || !element?.naturalWidth || !element.naturalHeight)
      return { x: 0, y: 0 };
    const fit = Math.min(
      frame.width / element.naturalWidth,
      frame.height / element.naturalHeight,
    );
    const width = element.naturalWidth * fit * nextZoom;
    const height = element.naturalHeight * fit * nextZoom;
    return {
      x: Math.max(0, (width - frame.width) / 2),
      y: Math.max(0, (height - frame.height) / 2),
    };
  };
  const setBoundedZoom = (value: number) => {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    const limits = panLimits(next);
    setZoom(next);
    setOffset((current) => ({
      x: clamp(current.x, limits.x),
      y: clamp(current.y, limits.y),
    }));
  };
  const choose = (index: number) => {
    const item = attachments[index];
    if (!item) return;
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    select(item.url);
  };

  useEffect(() => {
    const reset = () => setBoundedZoom(zoom);
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  });

  if (!selected || !source)
    return (
      <p className={styles.mediaReviewUnavailable} role="status">
        Image unavailable
      </p>
    );
  return (
    <div
      ref={stage}
      className={`${styles.imageReviewStage} ${pannable ? styles.imageReviewPannable : ""} ${dragging ? styles.imageReviewDragging : ""}`}
      onPointerDown={(event) => {
        if (!pannable) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          origin: { x: event.clientX, y: event.clientY },
          offset,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointer !== event.pointerId) return;
        const limits = panLimits();
        setOffset({
          x: clamp(active.offset.x + event.clientX - active.origin.x, limits.x),
          y: clamp(active.offset.y + event.clientY - active.origin.y, limits.y),
        });
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = undefined;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setDragging(false);
      }}
    >
      <img
        ref={image}
        src={source}
        alt="Attachment preview"
        draggable={false}
        style={{
          transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`,
        }}
      />
      <div
        className={styles.imageReviewToolbar}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {attachments.length > 1 && (
          <div className={styles.imageReviewSwitcher}>
            <button
              type="button"
              aria-label="Previous image"
              disabled={selectedIndex === 0}
              onClick={() => choose(selectedIndex - 1)}
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <span>
              {selectedIndex + 1} / {attachments.length}
            </span>
            <button
              type="button"
              aria-label="Next image"
              disabled={selectedIndex === attachments.length - 1}
              onClick={() => choose(selectedIndex + 1)}
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className={styles.imageReviewZoom}>
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setBoundedZoom(zoom - ZOOM_STEP)}
          >
            <Minus size={16} aria-hidden="true" />
          </button>
          <input
            type="range"
            aria-label="Image zoom"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            value={zoom}
            onChange={(event) =>
              setBoundedZoom(Number(event.currentTarget.value))
            }
          />
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setBoundedZoom(zoom + ZOOM_STEP)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.imageReviewPercent}
            aria-label="Reset image zoom"
            onClick={() => setBoundedZoom(MIN_ZOOM)}
          >
            {Math.round(zoom * 100)}%
          </button>
        </div>
        <a
          href={source}
          download
          aria-label="Download image"
          title="Download image"
        >
          <Download size={17} aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
