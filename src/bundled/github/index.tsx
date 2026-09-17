import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useMemo, useState } from "react";
import {
  IconExternalLink as ExternalLink,
  IconGitPullRequest as GitPullRequest,
  IconCircleDot as CircleDot,
  IconGitCommit as GitCommitHorizontal,
  IconFolderCode as FolderGit2,
} from "@tabler/icons-react";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import { parseGitHubReference, type GitHubReference } from "./references";
import { loadGitHubDetails, type GitHubDetails } from "./data";
import styles from "./GitHub.module.css";

export const inject = ["panels"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "object",
    title: "GitHub",
    matches: (target) => !!parseGitHubReference(target),
    component: GitHubPanel,
  });
};
const labels = {
  repository: "Repository",
  pull: "Pull request",
  issue: "Issue",
  commit: "Commit",
};
const icons = {
  repository: FolderGit2,
  pull: GitPullRequest,
  issue: CircleDot,
  commit: GitCommitHorizontal,
};

export function GitHubPanel({ target }: PanelProps) {
  const [attempt, retry] = useState(0);
  const reference = useMemo(() => parseGitHubReference(target), [target]);
  return reference ? (
    <ObjectPanel
      key={`${reference.url}:${attempt}`}
      reference={reference}
      retry={() => retry(attempt + 1)}
    />
  ) : (
    <p className="notice">Unsupported GitHub link.</p>
  );
}

function ObjectPanel({
  reference,
  retry,
}: {
  reference: GitHubReference;
  retry(): void;
}) {
  const [result, setResult] = useState<GitHubDetails | string>();
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void loadGitHubDetails(
      reference,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    )
      .then((details) => {
        if (!controller.signal.aborted) setResult(details);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [reference]);
  const Icon = icons[reference.kind];
  return (
    <div className={styles.root}>
      <div className={styles.identity}>
        <span className={styles.icon}>
          <Icon size={22} aria-hidden="true" />
        </span>
        <div>
          <small>{reference.repository}</small>
          <strong>
            {labels[reference.kind]} {reference.label}
          </strong>
        </div>
      </div>
      <a
        className={styles.external}
        href={reference.url}
        target="_blank"
        rel="noreferrer"
      >
        Open on GitHub <ExternalLink size={14} aria-hidden="true" />
      </a>
      {result === undefined ? (
        <p role="status">Loading from GitHub…</p>
      ) : typeof result === "string" ? (
        <div role="alert">
          <p>{result}</p>
          <Button type="button" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <div className={styles.byline}>
            {result.state && (
              <span className={styles.state}>{result.state}</span>
            )}
            {result.author && <span>by {result.author}</span>}
          </div>
          <h2>{result.title}</h2>
          {!!result.facts.length && (
            <dl className={styles.facts}>
              {result.facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {result.body && <p className={styles.body}>{result.body}</p>}
        </>
      )}
      <p className={styles.note}>
        Public GitHub data · Open on GitHub for private repositories and
        actions.
      </p>
    </div>
  );
}
