import { useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import { Button } from "../../shared/design-system/ui/Button";
import { loadEmbeddingPolicy, type EmbeddingPolicy } from "../run402/config";
import { parseKygitRepo, type KygitLink } from "./references";
import styles from "./Kygit.module.css";

export const inject = ["panels"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "repo",
    title: "KyGit",
    matches: (target) => !!parseKygitRepo(target),
    component: KygitPanel,
  });
};

/**
 * Same sandbox as the run402 site panel. `allow-popups-to-escape-sandbox` is
 * load-bearing: the viewer signs in through a popup that must be a normal
 * top-level window (console cookies, WebAuthn). Never the top window.
 */
export const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

export function KygitPanel({ target }: PanelProps) {
  const [attempt, retry] = useState(0);
  const link = useMemo(() => parseKygitRepo(target), [target]);
  return link ? (
    <RepoPanel
      key={`${link.url}:${attempt}`}
      link={link}
      retry={() => retry(attempt + 1)}
    />
  ) : (
    <p className="notice">Unsupported KyGit link.</p>
  );
}

function RepoPanel({ link, retry }: { link: KygitLink; retry(): void }) {
  const [result, setResult] = useState<EmbeddingPolicy | string>();
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void loadEmbeddingPolicy(
      link.host,
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
  }, [link]);
  return <RepoView link={link} result={result} retry={retry} />;
}

/**
 * Presentation for every state; only `embeddable` renders a frame. The frame
 * is a black box: nothing is posted into it and nothing is listened for.
 * Sign-in state and verification are rendered by the viewer inside it.
 */
export function RepoView({
  link,
  result,
  retry,
}: {
  link: KygitLink;
  result: EmbeddingPolicy | string | undefined;
  retry(): void;
}) {
  const [reloads, reload] = useState(0);
  if (result === undefined)
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <p role="status">Checking whether {link.host} allows embedding…</p>
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
        <OpenInBrowser link={link} block />
      </div>
    );
  if (result.kind === "not-run402")
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <p>
          {link.host} isn’t serving Run402 Source right now, so there is nothing
          to show here.
        </p>
        <OpenInBrowser link={link} block />
      </div>
    );
  if (result.kind === "not-embeddable")
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <p>The source viewer doesn’t allow embedding from this origin.</p>
        <OpenInBrowser link={link} block />
      </div>
    );
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.address} title={link.url}>
          <span className={styles.brand}>KyGit</span> {link.address}
          {link.detail ? (
            <span className={styles.detail}>{link.detail}</span>
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="compact"
          aria-label="Reload repository view"
          onClick={() => reload(reloads + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" /> Reload
        </Button>
        <OpenInBrowser link={link} />
      </div>
      <iframe
        key={reloads}
        className={styles.frame}
        src={link.url}
        title={`KyGit ${link.address}`}
        sandbox={FRAME_SANDBOX}
        referrerPolicy="strict-origin-when-cross-origin"
        allow=""
      />
    </div>
  );
}

function OpenInBrowser({ link, block }: { link: KygitLink; block?: boolean }) {
  return (
    <a
      className={block ? styles.external : styles.open}
      href={link.url}
      target="_blank"
      rel="noreferrer"
    >
      Open in browser <ExternalLink size={14} aria-hidden="true" />
    </a>
  );
}
