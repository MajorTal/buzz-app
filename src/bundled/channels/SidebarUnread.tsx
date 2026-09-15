import {
  IconArrowDown as ArrowDown,
  IconArrowUp as ArrowUp,
} from "@tabler/icons-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import styles from "./Channels.module.css";

type Edges = { above: HTMLButtonElement[]; below: HTMLButtonElement[] };

/** Geometry over the existing badges, not another unread store or subscription. */
function unreadEdges(list: HTMLElement): Edges {
  const edges: Edges = { above: [], below: [] };
  const viewport = list.getBoundingClientRect();
  if (!list.clientHeight || !viewport.width) return edges;
  for (const badge of list.querySelectorAll("[data-channel-unread]")) {
    const row = badge.closest("button");
    if (!row) continue;
    // A collapsed section represents its hidden rows at the summary. Clicking
    // an edge cue expands that section before revealing the actual channel.
    const closed = row.closest("details:not([open])");
    const anchor = closed?.querySelector("summary") ?? row;
    const rect = anchor.getBoundingClientRect();
    if (!rect.height || !rect.width) continue;
    if (rect.bottom <= viewport.top) edges.above.push(row);
    else if (rect.top >= viewport.top + list.clientHeight)
      edges.below.push(row);
  }
  return edges;
}

export function SidebarUnread({
  children,
  listRef,
}: {
  children: ReactNode;
  listRef?: RefObject<HTMLElement | null>;
}) {
  const ownList = useRef<HTMLElement>(null);
  const list = listRef ?? ownList;
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ above: [], below: [] });
  useEffect(() => {
    const viewport = list.current;
    const rows = content.current;
    if (!viewport || !rows) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = unreadEdges(viewport);
      setEdges((previous) =>
        (["above", "below"] as const).every(
          (edge) =>
            previous[edge].length === next[edge].length &&
            previous[edge].every((row, i) => row === next[edge][i]),
        )
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    resize.observe(rows);
    const mutations = new MutationObserver(schedule);
    mutations.observe(rows, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open", "data-channel-unread"],
    });
    viewport.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      viewport.removeEventListener("scroll", schedule);
    };
  }, [list]);
  const reveal = (edge: keyof Edges) => {
    const viewport = list.current;
    if (!viewport) return;
    // Recheck at activation: unread/roster changes may precede the queued frame.
    const targets = unreadEdges(viewport)[edge];
    const target = edge === "above" ? targets.at(-1) : targets[0];
    if (!target) return;
    const section = target.closest("details");
    if (section) section.open = true;
    const rect = target.getBoundingClientRect();
    viewport.scrollTop +=
      rect.top -
      viewport.getBoundingClientRect().top -
      (viewport.clientHeight - rect.height) / 2;
    // Continue keyboard navigation at the revealed row, not the start of the
    // roster. Its existing focus preparation still applies; focus is not selection.
    target.focus({ preventScroll: true });
  };
  return (
    <div className={styles.channelListFrame}>
      <nav
        ref={list}
        className={styles.channelList}
        aria-label="Subscribed channels"
      >
        <div ref={content} className={styles.channelListContent}>
          {children}
        </div>
      </nav>
      {(["above", "below"] as const).map((edge) => {
        if (!edges[edge].length) return null;
        const Icon = edge === "above" ? ArrowUp : ArrowDown;
        return (
          <button
            key={edge}
            type="button"
            className={styles.unreadEdge}
            data-edge={edge}
            title={`Reveal the nearest unread channel ${edge} without opening it`}
            onClick={() => reveal(edge)}
          >
            <Icon size={15} aria-hidden="true" />
            Unread {edge}
          </button>
        );
      })}
    </div>
  );
}
