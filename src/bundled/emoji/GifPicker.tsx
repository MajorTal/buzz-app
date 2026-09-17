import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Button } from "../../shared/design-system/ui/Button";
import { fetchKlipyGifs, type KlipyGif } from "../../features/relay/gifs";
import styles from "./Emoji.module.css";

const LOADING_TILES = [
  "tall-a",
  "short-a",
  "short-b",
  "tall-b",
  "tall-c",
  "short-c",
  "short-d",
  "tall-d",
] as const;

export function GifPicker({
  community,
  initialQuery,
  onQueryChange,
  select,
}: {
  community: string;
  initialQuery: string;
  onQueryChange(query: string): void;
  select(gif: KlipyGif): void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery.trim());
  const [gifs, setGifs] = useState<KlipyGif[]>();
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const scrollbar = useRef<HTMLDivElement>(null);
  const scrollbarThumb = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);
  useLayoutEffect(() => {
    const scroll = results.current;
    const track = scrollbar.current;
    const thumb = scrollbarThumb.current;
    if (!scroll || !track || !thumb) return;
    const update = () => {
      const picker = scroll.parentElement?.getBoundingClientRect();
      const bounds = scroll.getBoundingClientRect();
      if (!picker) return;
      const trackHeight = Math.max(0, scroll.clientHeight - 16);
      const overflow = scroll.scrollHeight - scroll.clientHeight;
      track.hidden = overflow <= 0;
      track.style.top = `${bounds.top - picker.top + 8}px`;
      track.style.height = `${trackHeight}px`;
      if (overflow <= 0) return;
      const thumbHeight = Math.max(
        32,
        trackHeight * (scroll.clientHeight / scroll.scrollHeight),
      );
      const offset =
        (scroll.scrollTop / overflow) * Math.max(0, trackHeight - thumbHeight);
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${offset}px)`;
    };
    const resize = new ResizeObserver(update);
    resize.observe(scroll);
    if (scroll.firstElementChild) resize.observe(scroll.firstElementChild);
    const mutations = new MutationObserver(() => {
      if (scroll.firstElementChild) resize.observe(scroll.firstElementChild);
      update();
    });
    mutations.observe(scroll, { childList: true });
    scroll.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      scroll.removeEventListener("scroll", update);
    };
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      500,
    );
    return () => window.clearTimeout(timeout);
  }, [query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same request.
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    setGifs(undefined);
    void fetchKlipyGifs(community, debouncedQuery, controller.signal).then(
      setGifs,
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => controller.abort();
  }, [community, debouncedQuery, attempt]);

  return (
    <div className={styles.gifPicker}>
      <div className={styles.gifSearch}>
        <SearchField
          inputRef={input}
          label="Search GIFs"
          placeholder="Search GIFs"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            onQueryChange(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </div>
      <div ref={results} className={styles.gifResults}>
        {!gifs && !error ? (
          <div
            className={styles.gifLoading}
            role="status"
            aria-label="Loading GIFs"
          >
            {LOADING_TILES.map((tile) => (
              <span key={tile} />
            ))}
          </div>
        ) : error ? (
          <div className={styles.gifEmpty} role="alert">
            <p>{error}</p>
            <Button type="button" onClick={() => retry(attempt + 1)}>
              Try again
            </Button>
          </div>
        ) : gifs?.length ? (
          <div className={styles.gifGrid} data-testid="klipy-gif-grid">
            {gifs.map((gif) => (
              <button
                key={`${gif.id}-${gif.slug}`}
                type="button"
                aria-label={`Choose ${gif.title}`}
                title={gif.title}
                onClick={() => select(gif)}
              >
                <img
                  src={gif.preview.url}
                  alt={gif.title}
                  width={gif.preview.width}
                  height={gif.preview.height}
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.gifEmpty}>No GIFs found.</div>
        )}
      </div>
      <div
        ref={scrollbar}
        className={styles.gifScrollbarTrack}
        data-testid="gif-scrollbar-track"
        aria-hidden="true"
      >
        <div ref={scrollbarThumb} className={styles.gifScrollbarThumb} />
      </div>
      <div className={styles.gifAttribution}>Powered by KLIPY</div>
    </div>
  );
}
