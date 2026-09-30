import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  BrowserIcon,
  TerminalWindowIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import styles from "./Panels.module.css";

type Item = {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
  /** Stable for one opening, including retained exit content. */
  instance?: object;
  close(): void;
};
type Identity = { label: string; icon?: ReactNode };
type Local = { id: string; label: string; owner: string; close(): void };
const TabHost = createContext<{
  owner: string;
  register(tab: Local): () => void;
  activate(owner: string, label: string): boolean;
  title(owner: string, identity: Identity | undefined): void;
  slots: ReadonlyMap<string, HTMLDivElement>;
} | null>(null);
export function usePanelTabHost() {
  return useContext(TabHost);
}

export function usePanelTabTitle(label: string, icon?: ReactNode) {
  const host = usePanelTabHost();
  const title = host?.title;
  const owner = host?.owner;
  useLayoutEffect(() => {
    if (!title || !owner) return;
    title(owner, { label, icon });
    return () => title(owner, undefined);
  }, [title, owner, label, icon]);
}

/** The channel owns target tabs; private details retain their feature's lifetime. */
export function PanelWorkspace({
  items,
  value,
  select,
  add,
  focusOnMount = true,
}: {
  items: Item[];
  value: string;
  select(id: string): void;
  add?: (() => void) | undefined;
  /** Restoring a channel visit leaves focus with its main conversation. */
  focusOnMount?: boolean;
}) {
  const prefix = useId();
  const panelId = (id: string) => `${prefix}-${id}`;
  const [titles, setTitles] = useState<Record<string, Identity | undefined>>(
    {},
  );
  const title = useCallback((owner: string, identity: Identity | undefined) => {
    setTitles((current) =>
      current[owner] === identity ? current : { ...current, [owner]: identity },
    );
  }, []);
  const [locals, setLocals] = useState<Local[]>([]);
  const [localSelection, setLocalSelection] = useState<string>();
  const [slots, setSlots] = useState(new Map<string, HTMLDivElement>());
  const root = useRef<HTMLDivElement>(null);
  const focusTab = useRef(false);
  const closingTab = useRef<string | undefined>(undefined);
  const register = useCallback((tab: Local) => {
    setLocals((current) => [
      ...current.filter((item) => item.id !== tab.id),
      tab,
    ]);
    setLocalSelection(tab.id);
    focusTab.current = true;
    return () => {
      setLocals((current) => current.filter((item) => item.id !== tab.id));
      setLocalSelection((current) =>
        current === tab.id ? undefined : current,
      );
    };
  }, []);
  const setSlot = useCallback((id: string, element: HTMLDivElement | null) => {
    setSlots((current) => {
      if (current.get(id) === element || (!element && !current.has(id)))
        return current;
      const next = new Map(current);
      if (element) next.set(id, element);
      else next.delete(id);
      return next;
    });
  }, []);
  const owned = locals.filter((tab) =>
    items.some((item) => item.id === tab.owner),
  );
  const activate = useCallback(
    (owner: string, label: string) => {
      const tab = locals.find(
        (tab) => tab.owner === owner && tab.label === label,
      );
      if (!tab) return false;
      setLocalSelection(tab.id);
      return true;
    },
    [locals],
  );
  const selectedLocal = owned.find(
    (tab) => tab.id === localSelection && tab.owner === value,
  );
  const selected = selectedLocal?.id ?? value;
  const tabs = items.flatMap((item) => [
    {
      ...item,
      ...titles[item.id],
      icon: titles[item.id]?.icon ?? item.icon ?? <BrowserIcon size="1rem" />,
    },
    ...owned
      .filter((tab) => tab.owner === item.id)
      .map((tab) => ({ ...tab, icon: <TerminalWindowIcon size="1rem" /> })),
  ]);
  const active = tabs.find((tab) => tab.id === selected);
  const previous = useRef<string>(focusOnMount ? undefined : selected);
  const instance = items.find((item) => item.id === selected)?.instance;
  const previousInstance = useRef<object>(focusOnMount ? undefined : instance);
  useLayoutEffect(() => {
    if (
      previous.current !== selected ||
      previousInstance.current !== instance ||
      focusTab.current ||
      (closingTab.current && !tabs.some((tab) => tab.id === closingTab.current))
    ) {
      const tab = root.current?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      tab?.focus({ preventScroll: true });
      tab?.parentElement?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
      previous.current = selected;
      previousInstance.current = instance;
      focusTab.current = false;
      closingTab.current = undefined;
    }
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from descendant controls closes their active tab.
    <div
      data-panel-workspace=""
      className={styles.workspace}
      ref={root}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229 &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.stopPropagation();
          active?.close();
        }
      }}
    >
      <PanelHeader
        actions={
          add && (
            <span className={styles.addTab}>
              <IconButton
                size="toolbar"
                aria-label="Add tab"
                title="Add tab"
                icon={<PlusIcon size="1rem" />}
                onClick={add}
              />
            </span>
          )
        }
        title={
          <Tabs
            label="Panel tabs"
            variant="navigation"
            value={selected}
            items={tabs.map((tab) => ({
              value: tab.id,
              label: tab.label,
              icon: tab.icon,
              panelId: panelId(tab.id),
              onClose: () => {
                closingTab.current = tab.id;
                tab.close();
              },
            }))}
            onValueChange={(id) => {
              const local = owned.find((tab) => tab.id === id);
              setLocalSelection(local?.id);
              select(local?.owner ?? id);
            }}
          />
        }
      />
      <div className={styles.workspaceBody}>
        {items.map((item) => (
          <TabScope
            key={item.id}
            owner={item.id}
            activate={activate}
            title={title}
            register={register}
            slots={slots}
          >
            <div
              role="tabpanel"
              id={panelId(item.id)}
              aria-labelledby={`${panelId(item.id)}-tab`}
              className={styles.workspacePane}
              data-covered={selected !== item.id || undefined}
              inert={selected !== item.id}
              aria-hidden={selected !== item.id || undefined}
            >
              {item.content}
            </div>
          </TabScope>
        ))}
        {owned.map((tab) => (
          <LocalSlot
            key={tab.id}
            id={tab.id}
            panelId={panelId(tab.id)}
            selected={selected === tab.id}
            setSlot={setSlot}
          />
        ))}
      </div>
    </div>
  );
}
function TabScope({
  owner,
  activate,
  title,
  register,
  slots,
  children,
}: NonNullable<ReturnType<typeof usePanelTabHost>> & { children: ReactNode }) {
  const value = useMemo(
    () => ({ owner, activate, title, register, slots }),
    [owner, activate, title, register, slots],
  );
  return <TabHost.Provider value={value}>{children}</TabHost.Provider>;
}
function LocalSlot({
  id,
  panelId,
  selected,
  setSlot,
}: {
  id: string;
  panelId: string;
  selected: boolean;
  setSlot(id: string, element: HTMLDivElement | null): void;
}) {
  const ref = useCallback(
    (element: HTMLDivElement | null) => setSlot(id, element),
    [id, setSlot],
  );
  return (
    <div
      ref={ref}
      role="tabpanel"
      id={panelId}
      aria-labelledby={`${panelId}-tab`}
      className={styles.workspacePane}
      data-covered={!selected || undefined}
      inert={!selected}
      aria-hidden={!selected || undefined}
    />
  );
}
export function PanelLocalTab({
  title,
  close,
  children,
}: {
  title: string;
  close(): void;
  children: ReactNode;
}) {
  const host = usePanelTabHost();
  const id = useId();
  const onClose = useRef(close);
  onClose.current = close;
  const register = host?.register;
  const owner = host?.owner;
  useLayoutEffect(() => {
    if (!register || !owner) return;
    return register({
      id,
      label: title,
      owner,
      close: () => onClose.current(),
    });
  }, [register, owner, id, title]);
  const slot = host?.slots.get(id);
  return slot
    ? createPortal(
        <section className={styles.tabDetail} aria-label={title}>
          {children}
        </section>,
        slot,
      )
    : null;
}
