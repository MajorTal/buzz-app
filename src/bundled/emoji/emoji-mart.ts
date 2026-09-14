// Emoji Mart config adapted from block/buzz's shared picker; see NOTICE.md.
import data from "@emoji-mart/data";
import { Data, Picker, SearchIndex } from "emoji-mart";
import { parseColorMode } from "../../shared/theme/service";
import type { CustomEmoji } from "../../features/relay/emoji";

const prefix = "buzz-custom/";
const categoryIcon = (name: string, paths: string) => ({
  svg: [
    `<svg class="lucide lucide-${name}" xmlns="http://www.w3.org/2000/svg"`,
    'viewBox="0 0 24 24" fill="none" stroke="currentColor"',
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    paths,
    "</svg>",
  ].join(" "),
});
const categoryIcons = {
  frequent: categoryIcon(
    "clock",
    '<circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path>',
  ),
  people: categoryIcon(
    "face-slightly-smiling",
    '<path d="M15 10V9"></path><path d="M16.472 15a6 6 0 0 1-8.943 0"></path><path d="M9 10V9"></path><circle cx="12" cy="12" r="10"></circle>',
  ),
  nature: categoryIcon(
    "paw-print",
    '<circle cx="11" cy="4" r="2"></circle><circle cx="18" cy="8" r="2"></circle><circle cx="20" cy="16" r="2"></circle><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"></path>',
  ),
  foods: categoryIcon(
    "apple",
    '<path d="M12 6.528V3a1 1 0 0 1 1-1h0"></path><path d="M18.237 21A15 15 0 0 0 22 11a6 6 0 0 0-10-4.472A6 6 0 0 0 2 11a15.1 15.1 0 0 0 3.763 10 3 3 0 0 0 3.648.648 5.5 5.5 0 0 1 5.178 0A3 3 0 0 0 18.237 21"></path>',
  ),
  activity: categoryIcon(
    "dumbbell",
    '<path d="M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z"></path><path d="m2.5 21.5 1.4-1.4"></path><path d="m20.1 3.9 1.4-1.4"></path><path d="M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z"></path><path d="m9.6 14.4 4.8-4.8"></path>',
  ),
  places: categoryIcon(
    "car-front",
    '<path d="m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8"></path><path d="M7 14h.01"></path><path d="M17 14h.01"></path><rect width="18" height="8" x="3" y="10" rx="2"></rect><path d="M5 18v2"></path><path d="M19 18v2"></path>',
  ),
  objects: categoryIcon(
    "lightbulb",
    '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"></path><path d="M9 18h6"></path><path d="M10 22h4"></path>',
  ),
  symbols: categoryIcon(
    "shapes",
    '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"></path><rect x="3" y="14" width="7" height="7" rx="1"></rect><circle cx="17.5" cy="17.5" r="3.5"></circle>',
  ),
  flags: categoryIcon(
    "flag",
    '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"></path>',
  ),
  custom: categoryIcon(
    "asterisk",
    '<path d="M12 6v12"></path><path d="M17.196 9 6.804 15"></path><path d="m6.804 9 10.392 6"></path>',
  ),
  "buzz-custom": categoryIcon(
    "asterisk",
    '<path d="M12 6v12"></path><path d="M17.196 9 6.804 15"></path><path d="m6.804 9 10.392 6"></path>',
  ),
};
let active: (() => void) | undefined;

/** Mart owns a module-global dictionary/search index. Only one mounted picker
 * may use it; a React remount alone neither removes old emoji nor isolates scope. */
export function mountEmojiMart({
  host,
  scope,
  perLine,
  emojiSize,
  emojiButtonSize,
  search,
  searchChange,
  entries,
  media,
  select,
  close,
}: {
  host: HTMLDivElement;
  scope: string;
  perLine: number;
  emojiSize: number;
  emojiButtonSize: number;
  search: string;
  searchChange(value: string): void;
  entries: readonly CustomEmoji[];
  media(url: string): string | undefined;
  select(value: string, customEmoji?: string): void;
  close(): void;
}) {
  active?.();
  let disposed = false;
  const values = new Map<string, { literal: string; shortcode: string }>();
  const emojis = entries.flatMap(({ shortcode, url }) => {
    const src = media(url);
    if (!src) return [];
    const id = `${prefix}${encodeURIComponent(scope)}/${shortcode}`;
    const literal = `:${shortcode}:`;
    values.set(id, { literal, shortcode });
    // Match Mart's first-hyphen query normalization as well as individual words.
    const terms = [shortcode, literal].flatMap((name) => [
      name,
      ...name.replace(/(\w)-/, "$1 ").split(/[\s|,]+/),
      ...name.split(/[-_]+/),
    ]);
    return [
      {
        id,
        name: literal,
        keywords: [shortcode],
        // Supplying search/shortcodes prevents Mart from exposing its scoped ID.
        search: `,${terms.join(",")}`,
        skins: [{ src, shortcodes: literal }],
      },
    ];
  });
  // Restore Mart's default Frequent row if storage contains a poisoned empty map.
  try {
    if (localStorage.getItem("emoji-mart.frequently") === "{}") {
      localStorage.removeItem("emoji-mart.frequently");
      localStorage.removeItem("emoji-mart.last");
    }
  } catch {
    /* Like Mart, selection works without localStorage. */
  }
  const picker = new Picker({
    data,
    custom: emojis.length
      ? [{ id: "buzz-custom", name: "Custom", emojis }]
      : [],
    autoFocus: false,
    categoryIcons,
    emojiButtonSize,
    emojiSize,
    dynamicWidth: false,
    maxFrequentRows: 2,
    // Ten category tabs overlap in narrow thread panes; search/scroll still work.
    navPosition: perLine < 6 ? "none" : "bottom",
    perLine,
    previewPosition: "none",
    set: "native",
    skinTonePosition: "search",
    // Widget mode follows the host, never the OS independently.
    theme: parseColorMode(host.ownerDocument.documentElement.dataset.colorMode),
    onEmojiSelect: (emoji: { native?: string; id?: string }) => {
      if (disposed) return;
      if (emoji.native) {
        select(emoji.native);
        return;
      }
      const custom = values.get(emoji.id ?? "");
      if (custom) select(custom.literal, custom.shortcode);
    },
  }) as unknown as HTMLElement;
  // The documented web-component attribute updates in place: do not recreate the
  // picker/dictionary (or lose search, focus and scroll) just to change appearance.
  const documentRoot = host.ownerDocument.documentElement;
  const themeObserver = new MutationObserver(() => {
    picker.setAttribute(
      "theme",
      parseColorMode(documentRoot.dataset.colorMode),
    );
  });
  themeObserver.observe(documentRoot, {
    attributes: true,
    attributeFilter: ["data-color-mode"],
  });
  // Like the legacy picker, own search focus/corrections after async shadow render.
  const root = picker.shadowRoot;
  const navigationStyle = host.ownerDocument.createElement("style");
  navigationStyle.textContent = `
    #root[data-theme="light"] {
      --buzz-category-fill: #f0f0f0;
      --buzz-category-icon: #8d8d8d;
      --buzz-category-icon-selected: #0a0a0a;
      --buzz-category-label: #646464;
      --buzz-scrollbar-thumb: #e8e8e8;
    }
    #root[data-theme="dark"] {
      --buzz-category-fill: #1c1c1c;
      --buzz-category-icon: #a6a6a6;
      --buzz-category-icon-selected: #f5f5f5;
      --buzz-category-label: #c1c1c1;
      --buzz-scrollbar-thumb: #424242;
    }
    #root {
      --padding: 8px;
      position: relative;
      width: 100% !important;
    }
    .scroll {
      padding-inline: 12px;
      scrollbar-width: none;
    }
    .scroll::-webkit-scrollbar {
      display: none;
    }
    .buzz-scrollbar-track {
      position: absolute;
      right: 4px;
      z-index: 4;
      width: 8px;
      opacity: .6;
      pointer-events: none;
    }
    .buzz-scrollbar-thumb {
      position: absolute;
      top: 0;
      left: 0;
      width: 8px;
      min-height: 32px;
      border-radius: 9999rem;
      background: var(--buzz-scrollbar-thumb);
    }
    .scroll > div {
      width: 100% !important;
    }
    .category .sticky {
      color: var(--buzz-category-label);
      font-size: calc(.75rem * var(--buzz-text-scale, 1));
      font-weight: 400;
      letter-spacing: 0;
      line-height: 1.5;
    }
    .search input[type="search"] {
      width: calc(100% - 4px);
      height: 28px;
      padding: 0 32px;
      margin-inline: 2px;
      border: 0;
      border-radius: var(--picker-search-radius);
      background: var(--picker-search-background);
      box-shadow: 0 0 0 1px var(--picker-search-background);
      color: var(--picker-search-foreground);
      font-family: var(--font-legacy-sans);
      font-size: calc(14px * var(--buzz-text-scale, 1));
      line-height: normal;
      transition:
        opacity 100ms ease,
        background 100ms ease,
        box-shadow 100ms ease;
    }
    .search input[type="search"]:focus {
      background: var(--picker-search-background);
      box-shadow: 0 0 0 2px var(--picker-search-ring);
      outline: none;
    }
    .search input[type="search"]::placeholder,
    .search .icon {
      color: var(--picker-search-muted);
      opacity: 1;
    }
    .search .loupe {
      visibility: hidden;
    }
    .search .delete {
      right: 10px;
      width: 16px;
      height: 16px;
      padding: 0;
      color: var(--picker-search-muted);
    }
    .search .delete svg {
      width: 16px;
      height: 16px;
    }
    .search .delete svg circle {
      fill: currentColor;
      stroke: none;
    }
    .search .delete svg path {
      fill: none;
      stroke: var(--picker-search-background);
    }
    .spacer {
      height: var(--picker-search-top-space, 4px);
    }
    .spacer + .flex.flex-middle {
      padding-bottom: 4px;
    }
    .spacer + .flex.flex-middle > .flex.flex-auto.flex-center.flex-middle {
      width: 0 !important;
      height: 48px !important;
      overflow: hidden;
      visibility: hidden;
    }
    .category .emoji-mart-emoji img {
      max-width: 32px !important;
      max-height: 32px !important;
    }
    .scroll .category > :not(.sticky) > .flex {
      justify-content: space-between;
    }
    .scroll .category button {
      flex-shrink: 0;
    }
    #nav button {
      position: relative;
      z-index: 1;
      color: var(--buzz-category-icon);
    }
    #nav {
      box-sizing: border-box;
      width: 100%;
      padding-inline: var(--padding);
    }
    #nav > .flex.relative > button {
      flex: 1 1 0;
    }
    #nav .buzz-skin-tone-nav-button {
      height: 18px;
      flex: 1 1 0;
      border: 0;
    }
    #nav .lucide {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    #nav button::before {
      position: absolute;
      top: 50%;
      left: 50%;
      z-index: -1;
      width: 28px;
      height: 28px;
      border-radius: 9999rem;
      background: transparent;
      content: "";
      pointer-events: none;
      transform: translate(-50%, -50%);
      transition: background-color 120ms ease;
    }
    #nav button[aria-selected] {
      color: var(--buzz-category-icon-selected);
    }
    #nav button[aria-selected]::before {
      background: var(--buzz-category-fill);
    }
    #nav .buzz-skin-tone-nav-button:hover::before,
    #nav .buzz-skin-tone-nav-button[aria-selected]::before {
      background: var(--buzz-category-fill);
    }
    #nav .buzz-skin-tone-nav-button .skin-tone {
      position: relative;
      z-index: 1;
    }
    .buzz-skin-tone-source {
      width: 0 !important;
      height: 48px !important;
      overflow: hidden;
      visibility: hidden;
    }
    #nav .bar {
      display: none;
    }
    #root > .menu {
      top: auto !important;
      right: 8px !important;
      bottom: 42px !important;
      left: auto !important;
      z-index: 100 !important;
      transform-origin: 100% 100%;
    }
    @media (prefers-reduced-motion: reduce) {
      #nav button::before {
        transition-duration: 0ms;
      }
    }
  `;
  root?.appendChild(navigationStyle);
  let skinToneObserver: MutationObserver | undefined;
  let scrollbarCleanup: (() => void) | undefined;
  let scrollbarScroll: HTMLElement | undefined;
  let scrollbarUpdate: (() => void) | undefined;
  const installPersistentScrollbar = () => {
    const scroll = root?.querySelector<HTMLElement>(".scroll");
    const pickerRoot = root?.querySelector<HTMLElement>("#root");
    if (!scroll || !pickerRoot) return;
    if (scroll === scrollbarScroll) {
      scrollbarUpdate?.();
      return;
    }
    scrollbarCleanup?.();
    pickerRoot.querySelector(".buzz-scrollbar-track")?.remove();
    const track = host.ownerDocument.createElement("div");
    track.className = "buzz-scrollbar-track";
    track.setAttribute("aria-hidden", "true");
    const thumb = host.ownerDocument.createElement("div");
    thumb.className = "buzz-scrollbar-thumb";
    track.appendChild(thumb);
    pickerRoot.appendChild(track);
    const update = () => {
      const pickerBounds = pickerRoot.getBoundingClientRect();
      const scrollBounds = scroll.getBoundingClientRect();
      const trackHeight = Math.max(0, scroll.clientHeight - 16);
      const overflow = scroll.scrollHeight - scroll.clientHeight;
      track.hidden = overflow <= 0;
      track.style.top = `${scrollBounds.top - pickerBounds.top + 8}px`;
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
    scroll.addEventListener("scroll", update, { passive: true });
    scrollbarScroll = scroll;
    scrollbarUpdate = update;
    scrollbarCleanup = () => {
      resize.disconnect();
      scroll.removeEventListener("scroll", update);
      track.remove();
      scrollbarScroll = undefined;
      scrollbarUpdate = undefined;
    };
    update();
  };
  const placeSkinToneInNavigation = () => {
    const source = root?.querySelector<HTMLButtonElement>(".skin-tone-button");
    const navigation = root?.querySelector<HTMLElement>(
      "#nav > .flex.relative",
    );
    const bar = navigation?.querySelector<HTMLElement>(":scope > .bar");
    if (!source || !navigation || !bar) return false;
    if (navigation.querySelector(".buzz-skin-tone-nav-button")) return true;
    source.parentElement?.classList.add("buzz-skin-tone-source");
    const button = host.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "buzz-skin-tone-nav-button flex flex-center flex-middle";
    button.setAttribute(
      "aria-label",
      source.getAttribute("aria-label") ?? "Choose skin tone",
    );
    button.title = source.title;
    const tone = host.ownerDocument.createElement("span");
    button.appendChild(tone);
    let menuOpen = source.hasAttribute("aria-selected");
    const sync = () => {
      const selected = source.hasAttribute("aria-selected");
      button.toggleAttribute("aria-selected", selected);
      tone.className =
        source.querySelector(".skin-tone")?.className ?? "skin-tone";
      if (menuOpen && !selected) button.focus();
      menuOpen = selected;
    };
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => source.click());
    sync();
    navigation.insertBefore(button, bar);
    skinToneObserver?.disconnect();
    skinToneObserver = new MutationObserver(sync);
    skinToneObserver.observe(source, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    return true;
  };
  const installSearchClearIcon = () => {
    const icon = root?.querySelector<SVGSVGElement>(".search .delete svg");
    if (!icon || icon.dataset.buzzCircleX) return;
    icon.dataset.buzzCircleX = "true";
    icon.classList.add("lucide", "lucide-circle-x");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML =
      '<circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path>';
  };
  const focusSearch = () => {
    const input = root?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!root || !input || disposed) return;
    placeSkinToneInNavigation();
    installPersistentScrollbar();
    installSearchClearIcon();
    if (input.dataset.buzzSearchReady) return;
    input.dataset.buzzSearchReady = "true";
    input.addEventListener("input", () => searchChange(input.value));
    input.spellcheck = false;
    input.placeholder = "Search emoji";
    input.setAttribute("aria-label", "Search emoji");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    if (search) {
      input.value = search;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.focus();
  };
  const observer = new MutationObserver(focusSearch);
  if (root) observer.observe(root, { childList: true, subtree: true });
  host.appendChild(picker);
  focusSearch();
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    skinToneObserver?.disconnect();
    scrollbarCleanup?.();
    themeObserver.disconnect();
    picker.remove(); // unregisters Mart's document listeners and observers
    for (const id of values.keys()) delete Data?.emojis[id];
    if (Data) {
      Data.categories = Data.categories.filter(
        (c: { id: string }) => c.id !== "buzz-custom",
      );
      Data.originalCategories = Data.originalCategories.filter(
        (c: { id: string }) => c.id !== "buzz-custom",
      );
    }
    SearchIndex.reset();
    if (active === dismiss) active = undefined;
  }
  function dismiss() {
    dispose();
    close();
  }
  active = dismiss;
  // Search also caches results after deletion/replacement; recreate rather than update.
  SearchIndex.reset();
  return dispose;
}
