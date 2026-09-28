import scrollbarStyles from "../../shared/design-system/styles/scrollbars.css?raw";
import searchFieldStyles from "../../shared/design-system/styles/search-field.css?raw";
import { pickerIcons } from "../../shared/design-system/icons/svg";
// Emoji Mart config adapted from block/buzz's shared picker; see NOTICE.md.
import data from "@emoji-mart/data";
import { Data, Picker, SearchIndex } from "emoji-mart";
import type { CustomEmoji } from "../../features/relay/emoji";

const resolvedTheme = (value: unknown): "light" | "dark" =>
  value === "dark" ? "dark" : "light";

const prefix = "buzz-custom/";
const categoryIcons = {
  frequent: { svg: pickerIcons.clock },
  people: { svg: pickerIcons.smiley },
  nature: { svg: pickerIcons["paw-print"] },
  foods: { svg: pickerIcons.orange },
  activity: { svg: pickerIcons.barbell },
  places: { svg: pickerIcons.car },
  objects: { svg: pickerIcons.lightbulb },
  symbols: { svg: pickerIcons.shapes },
  flags: { svg: pickerIcons.flag },
  custom: { svg: pickerIcons.asterisk },
  "buzz-custom": { svg: pickerIcons.asterisk },
};
let active: (() => void) | undefined;

/** Mart owns a module-global dictionary/search index. Only one mounted picker
 * may use it; a React remount alone neither removes old emoji nor isolates scope. */
export function mountEmojiMart({
  host,
  colorMode,
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
  colorMode?: "light" | "dark" | undefined;
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
    theme: resolvedTheme(
      colorMode ?? host.ownerDocument.documentElement.dataset.colorMode,
    ),
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
  const syncAppearance = () => {
    picker.setAttribute(
      "theme",
      resolvedTheme(colorMode ?? documentRoot.dataset.colorMode),
    );
    picker.toggleAttribute(
      "data-keyboard-navigation",
      documentRoot.hasAttribute("data-keyboard-navigation"),
    );
  };
  syncAppearance();
  const themeObserver = new MutationObserver(syncAppearance);
  themeObserver.observe(documentRoot, {
    attributes: true,
    attributeFilter: ["data-color-mode", "data-keyboard-navigation"],
  });
  // Like the legacy picker, own search focus/corrections after async shadow render.
  const root = picker.shadowRoot;
  const navigationStyle = host.ownerDocument.createElement("style");
  navigationStyle.textContent = `
    :host {
      --font-family: var(--font-sans);
      --font-size: var(--text-body-sm);
    }
    #root, input, button {
      color: var(--text-standard);
      font-family: var(--font-sans);
      font-size: var(--text-body-sm);
      line-height: var(--text-body-sm--line-height);
    }
    #root {
      --color-a: var(--text-standard);
      --color-b: var(--text-subtle);
      --color-c: var(--text-metadata);
      --em-color-border: var(--border-standard);
      --em-color-border-over: var(--affordance-selected);
      --buzz-category-fill: var(--affordance-selected);
      --buzz-category-icon: var(--text-subtle);
      --buzz-category-icon-selected: var(--text-standard);
      --buzz-category-label: var(--text-subtle);
      background: var(--surface-popover);
      color: var(--text-standard);
      font-family: var(--font-sans);
    }
    #root {
      --padding: var(--space-2);
      position: relative;
      width: 100% !important;
    }
    .scroll {
      padding-inline: var(--space-3);
    }
    .scroll > div {
      width: 100% !important;
    }
    .category .sticky {
      background: var(--surface-popover);
      color: var(--buzz-category-label);
      font-size: var(--text-caption);
      font-weight: var(--type-weight-normal);
      letter-spacing: 0;
      line-height: var(--text-caption--line-height);
    }
    .search.search-field {
      width: calc(100% - var(--space-2));
      margin: var(--picker-search-top, var(--space-3)) var(--space-1) var(--space-3);
    }
    .search .icon {
      top: auto;
      right: auto;
      left: auto;
      transform: none;
    }
    .search .loupe {
      position: static;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      order: 0;
      color: var(--text-metadata);
      opacity: 1;
      pointer-events: none;
    }
    .search .icon svg {
      width: 16px;
      height: 16px;
    }

    .spacer {
      height: 0;
    }
    .spacer + .flex.flex-middle > .flex.flex-auto.flex-center.flex-middle {
      width: 0 !important;
      height: 0 !important;
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
      display: grid;
      width: 100%;
      height: var(--size-control);
      flex-shrink: 0;
      align-items: center;
      padding: 0 var(--padding);
    }
    #nav > .flex.relative > button {
      flex: 1 1 0;
    }
    #nav .buzz-skin-tone-nav-button {
      height: 18px;
      flex: 1 1 0;
      border: 0;
    }

    #nav button::before {
      position: absolute;
      top: 50%;
      left: 50%;
      z-index: -1;
      width: 28px;
      height: 28px;
      border-radius: var(--radius-pill);
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
      height: 0 !important;
      overflow: hidden;
      visibility: hidden;
    }
    #nav .bar {
      display: none;
    }
    #root > .menu {
      background: var(--surface-popover);
      border-color: var(--border-standard);
      border-radius: var(--radius-row);
      padding: var(--space-1);
      box-shadow: var(--shadow-sm);
      backdrop-filter: none;
      top: auto !important;
      right: 8px !important;
      bottom: var(--size-control) !important;
      left: auto !important;
      z-index: 100 !important;
      transform-origin: 100% 100%;
    }
    .menu .option {
      border-radius: var(--radius-chip);
      padding: var(--space-1) var(--space-1h);
    }
    .menu .option:hover {
      background: var(--affordance-selected);
      color: var(--text-standard);
    }
    .menu input[type="radio"]:checked + .option {
      box-shadow: 0 0 0 2px var(--text-standard);
    }
    @media (prefers-reduced-motion: reduce) {
      #nav button::before {
        transition-duration: 0ms;
      }
    }
  ${scrollbarStyles}
  ${searchFieldStyles}
  `;
  root?.appendChild(navigationStyle);
  let skinToneObserver: MutationObserver | undefined;
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
  const installSearchIcon = (
    selector: string,
    name: "x" | "magnifying-glass",
  ) => {
    const icon = root?.querySelector<SVGSVGElement>(selector);
    if (!icon || icon.dataset.buzzSearchIcon) return;
    const template = document.createElement("template");
    template.innerHTML = pickerIcons[name];
    const replacement = template.content.firstElementChild;
    if (!replacement) return;
    // Preserve the widget-owned node so its renderer does not insert a second SVG.
    for (const attribute of [...icon.attributes])
      icon.removeAttribute(attribute.name);
    for (const attribute of [...replacement.attributes])
      icon.setAttribute(attribute.name, attribute.value);
    icon.innerHTML = replacement.innerHTML;
    icon.dataset.buzzSearchIcon = name;
    icon.setAttribute("aria-hidden", "true");
  };
  const focusSearch = () => {
    const input = root?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!root || !input || disposed) return;
    placeSkinToneInNavigation();
    root.querySelector(".scroll")?.classList.add("buzz-thin-scrollbar");
    input.parentElement?.classList.add("search-field");
    root
      .querySelector(".search .delete")
      ?.setAttribute("data-search-clear", "");
    installSearchIcon(".search .loupe svg", "magnifying-glass");
    installSearchIcon(".search .delete svg", "x");
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
