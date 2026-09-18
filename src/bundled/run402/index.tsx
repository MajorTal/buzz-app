import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import { Button } from "../../shared/design-system/ui/Button";
import { parseRun402Site, type Run402Site } from "./references";
import { loadEmbeddingPolicy, type EmbeddingPolicy } from "./config";
import styles from "./Run402.module.css";

export const inject = ["panels"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "site",
    title: "Run402",
    matches: (target) => !!parseRun402Site(target),
    component: Run402Panel,
  });
};

/** Sandbox for a cross-origin tenant site: its own origin, scripts and forms; never the top window. */
export const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

/**
 * Public presentation context handed to a framed site: which conversation it
 * was opened from and, when a channel presentation supplies it, who is looking.
 * Claimed, not proven: the site must treat it as display metadata.
 */
export type BuzzFrameContext = Readonly<{
  type: "buzz.context";
  version: 1;
  channelId: string;
  channelName?: string;
  viewer?: string;
  relayUrl?: string;
}>;

export function frameContext(
  context: PanelProps["context"],
  channelContext: PanelProps["channelContext"],
): BuzzFrameContext | undefined {
  const channelId = channelContext?.channelId ?? context?.channelId;
  if (!channelId) return;
  return {
    type: "buzz.context",
    version: 1,
    channelId,
    ...(channelContext?.channelName
      ? { channelName: channelContext.channelName }
      : {}),
    ...(channelContext?.viewer ? { viewer: channelContext.viewer } : {}),
    ...(channelContext?.relayUrl ? { relayUrl: channelContext.relayUrl } : {}),
  };
}

export function Run402Panel({ target, context, channelContext }: PanelProps) {
  const [attempt, retry] = useState(0);
  const site = useMemo(() => parseRun402Site(target), [target]);
  const buzz = useMemo(
    () => frameContext(context, channelContext),
    [context, channelContext],
  );
  return site ? (
    <SitePanel
      key={`${site.url}:${attempt}`}
      site={site}
      buzz={buzz}
      retry={() => retry(attempt + 1)}
    />
  ) : (
    <p className="notice">Unsupported run402 link.</p>
  );
}

function SitePanel({
  site,
  buzz,
  retry,
}: {
  site: Run402Site;
  buzz: BuzzFrameContext | undefined;
  retry(): void;
}) {
  const [result, setResult] = useState<EmbeddingPolicy | string>();
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void loadEmbeddingPolicy(
      site.host,
      window.location.origin,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    )
      .then((policy) => {
        if (!controller.signal.aborted) setResult(policy);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [site]);
  return <SiteView site={site} buzz={buzz} result={result} retry={retry} />;
}

/** Presentation for every state; only `embeddable` renders a frame. */
export function SiteView({
  site,
  buzz,
  result,
  retry,
}: {
  site: Run402Site;
  buzz?: BuzzFrameContext | undefined;
  result: EmbeddingPolicy | string | undefined;
  retry(): void;
}) {
  const [reloads, reload] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = useMemo(() => new URL(site.url).origin, [site.url]);
  const post = () => {
    if (buzz && frame.current?.contentWindow)
      frame.current.contentWindow.postMessage(buzz, origin);
  };
  // The site may boot before or after the load event; answer its request too.
  useEffect(() => {
    if (!buzz) return;
    const listener = (event: MessageEvent) => {
      if (
        event.origin === origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === "buzz.context.request"
      )
        post();
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  });
  if (result === undefined)
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <p role="status">Checking whether {site.host} allows embedding…</p>
      </div>
    );
  if (typeof result === "string")
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <div role="alert">
          <p>{result}</p>
          <Button variant="quiet" size="compact" onClick={retry}>
            Try again
          </Button>
        </div>
        <OpenInBrowser site={site} block />
      </div>
    );
  if (result.kind === "not-run402")
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <p>
          {site.host} isn’t serving a run402 project right now, so there is
          nothing to show here.
        </p>
        <OpenInBrowser site={site} block />
      </div>
    );
  if (result.kind === "not-embeddable")
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <p>This app doesn’t allow embedding in Buzz.</p>
        <OpenInBrowser site={site} block />
        <p className={styles.note}>
          To allow it, deploy the site with{" "}
          <code>site.embedding.frame_ancestors: ["localhost"]</code>. Project{" "}
          <code>{result.projectId}</code>.
        </p>
      </div>
    );
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.host} title={site.url}>
          {site.host}
        </span>
        <Button
          variant="ghost"
          size="compact"
          aria-label="Reload site"
          onClick={() => reload(reloads + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" /> Reload
        </Button>
        <OpenInBrowser site={site} />
      </div>
      <iframe
        key={reloads}
        ref={frame}
        onLoad={post}
        className={styles.frame}
        src={site.url}
        title={site.host}
        sandbox={FRAME_SANDBOX}
        referrerPolicy="strict-origin-when-cross-origin"
        allow=""
      />
    </div>
  );
}

function OpenInBrowser({ site, block }: { site: Run402Site; block?: boolean }) {
  return (
    <a
      className={block ? styles.external : styles.open}
      href={site.url}
      target="_blank"
      rel="noreferrer"
    >
      Open in browser <ExternalLink size={14} aria-hidden="true" />
    </a>
  );
}
