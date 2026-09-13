import { decode } from "blurhash";
import { validatedBlurhash } from "../relay/blurhash";

export const BLURHASH_SIZE = 32;

/** Local, bounded raster only; no URL, source-sized canvas or retained cache. */
export function paintBlurhash(canvas: HTMLCanvasElement, hash: string): void {
  if (!validatedBlurhash(hash)) return;
  try {
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(BLURHASH_SIZE, BLURHASH_SIZE);
    image.data.set(decode(hash, BLURHASH_SIZE, BLURHASH_SIZE));
    context.putImageData(image, 0, 0);
  } catch {
    // Bad metadata, unavailable canvas or decoder failure keeps the frame's
    // existing background. Original loading must never depend on the preview.
  }
}
