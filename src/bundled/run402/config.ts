/** What the host itself says about being framed, read before any frame is rendered. */
export type EmbeddingPolicy =
  | { kind: "embeddable"; projectId: string }
  | { kind: "not-embeddable"; projectId: string }
  | { kind: "not-run402" };

type RuntimeConfig = {
  project_id?: unknown;
  embedding?: { frame_ancestors?: unknown } | null;
};

export const RUNTIME_CONFIG_PATH = "/_run402/config.json";

/**
 * Resolves the host's policy for `origin` (the page that would frame it).
 * Rejects only when the answer is unknown: network failure, timeout or a
 * server error. A 404 is an answer: this host is not a run402 project.
 */
export async function loadEmbeddingPolicy(
  host: string,
  origin: string,
  signal: AbortSignal,
): Promise<EmbeddingPolicy> {
  const response = await fetch(`https://${host}${RUNTIME_CONFIG_PATH}`, {
    signal,
    headers: { Accept: "application/json" },
    credentials: "omit",
  });
  if (response.status === 404) return { kind: "not-run402" };
  if (!response.ok)
    throw new Error(
      `${host} couldn’t report its embedding policy (${response.status}).`,
    );
  let config: RuntimeConfig;
  try {
    config = (await response.json()) as RuntimeConfig;
  } catch {
    return { kind: "not-run402" };
  }
  if (typeof config?.project_id !== "string") return { kind: "not-run402" };
  const ancestors = config.embedding?.frame_ancestors;
  const allowed =
    Array.isArray(ancestors) &&
    ancestors.some(
      (pattern) =>
        typeof pattern === "string" && originMatches(pattern, origin),
    );
  return {
    kind: allowed ? "embeddable" : "not-embeddable",
    projectId: config.project_id,
  };
}

/**
 * CSP `frame-ancestors` source matching for the cases run402 emits: an exact
 * origin, or an origin whose port is the `*` wildcard. Host-only sources and
 * scheme-only sources are treated as non-matching rather than guessed.
 */
export function originMatches(pattern: string, origin: string): boolean {
  let page: URL;
  try {
    page = new URL(origin);
  } catch {
    return false;
  }
  const source = /^([a-z][a-z0-9+.-]*):\/\/([^/:]+)(?::(\*|\d+))?$/i.exec(
    pattern.trim(),
  );
  if (!source) return false;
  const [, scheme, host, port] = source;
  if (!scheme || !host) return false;
  if (`${scheme.toLowerCase()}:` !== page.protocol) return false;
  if (host.toLowerCase() !== page.hostname) return false;
  if (port === "*") return true;
  const defaultPort = page.protocol === "https:" ? "443" : "80";
  return (port ?? defaultPort) === (page.port || defaultPort);
}
