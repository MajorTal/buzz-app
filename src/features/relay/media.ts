/** Avatar request warming, the react-native-web Image model: fetch and
 * decode() into detached images, then retain nothing. The browser's own HTTP
 * and decoded-image caches serve the real <img> mounts. Never warms
 * originals/attachments that this renderer doesn't display. */
export function createMediaPreparation() {
  const pending = new Set<string>();
  let queue: string[] = [];
  let disposed = false;
  const active = new Set<HTMLImageElement>();
  const cancellations = new Map<HTMLImageElement, () => void>();
  let decoded = 0;
  function pump() {
    if (disposed || typeof Image === "undefined") return;
    while (active.size < 2 && queue.length) {
      const url = queue.shift();
      if (url === undefined) break;
      const image = new Image();
      active.add(image);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        image.onload = image.onerror = null;
        active.delete(image);
        cancellations.delete(image);
        pending.delete(url);
        pump();
      };
      const timeout = setTimeout(() => {
        image.src = "";
        finish();
      }, 10000);
      cancellations.set(image, () => finish());
      image.onerror = () => finish();
      image.onload = () => {
        // Do not explicitly decode enormous originals just to prepare an avatar.
        if (image.naturalWidth * image.naturalHeight * 4 > 8 * 1024 * 1024) {
          finish();
          return;
        }
        void image
          .decode()
          .then(
            () => {
              decoded++;
            },
            () => {},
          )
          .finally(() => finish());
      };
      image.referrerPolicy = "no-referrer";
      image.src = url;
    }
  }
  return {
    prepare(urls: readonly string[]) {
      if (disposed || saveData() || typeof Image === "undefined") return;
      // New intent replaces queued speculation; active requests remain capped at two.
      for (const url of queue) pending.delete(url);
      queue = [];
      for (const url of [...new Set(urls)].slice(0, 24)) {
        if (pending.has(url)) continue;
        pending.add(url);
        queue.push(url);
      }
      pump();
    },
    stats: () => ({
      active: active.size,
      queued: queue.length,
      decoded,
    }),
    dispose() {
      disposed = true;
      queue = [];
      for (const image of active) {
        image.src = "";
        cancellations.get(image)?.();
      }
      pending.clear();
    },
  };
}

/** The Save-Data preference (Network Information API) opts out of speculative
 * media traffic. Demand fetches still happen; only warming is disabled. */
export function saveData(): boolean {
  try {
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    return connection?.saveData === true;
  } catch {
    return false;
  }
}
