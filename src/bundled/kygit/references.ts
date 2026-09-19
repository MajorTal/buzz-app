export type KygitLink = Readonly<{
  /** The clicked URL, unchanged: the viewer routes it. */
  url: string;
  host: string;
  /** `acme/api`, or `vault <id>` for an id-addressed repo. */
  address: string;
  kind: "repo" | "file" | "commit";
  /** Second header line for a file (`ref · path`) or a commit (short sha). */
  detail?: string;
}>;

/** The viewer's host. A kygit-branded host is a one-line addition here if it ever ships. */
export const VIEWER_HOSTS = new Set(["git.run402.com"]);
/** Viewer paths that are pages, not repos (`/`, `/login`, `/auth/return`, a bare `/repos`). */
const reservedOrgs = new Set(["repos", "auth", "login"]);
const segment = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const sha = /^[0-9a-f]{4,64}$/i;

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/**
 * Exact viewer-route parsing (gitvault-viewer-embedded-mode D6). Accepts
 * `/<org>/<repo>`, `/<org>/<repo>/blob/<ref>/<path…>`,
 * `/<org>/<repo>/commit/<sha>` and the same three under `/repos/id/<vault_id>`.
 * Everything else, including the viewer's own pages, keeps ordinary link behavior.
 */
export function parseKygitRepo(value: string): KygitLink | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password)
      return;
    if (!VIEWER_HOSTS.has(url.hostname)) return;
    const parts = url.pathname.split("/").filter(Boolean);
    let address: string;
    let rest: string[];
    if (parts[0] === "repos") {
      const vaultId = parts[2];
      if (parts[1] !== "id" || !vaultId) return;
      address = `vault ${decode(vaultId)}`;
      rest = parts.slice(3);
    } else {
      const [org, repo] = parts;
      if (!org || !repo || reservedOrgs.has(org)) return;
      if (!segment.test(org) || !segment.test(repo)) return;
      address = `${org}/${repo}`;
      rest = parts.slice(2);
    }
    const base = { url: url.href, host: url.hostname, address };
    if (rest.length === 0) return { ...base, kind: "repo" };
    const [form, first, ...pathParts] = rest;
    if (form === "blob" && first && pathParts.length >= 1) {
      const path = pathParts.map(decode).join("/");
      return { ...base, kind: "file", detail: `${decode(first)} · ${path}` };
    }
    if (
      form === "commit" &&
      first &&
      pathParts.length === 0 &&
      sha.test(first)
    ) {
      return {
        ...base,
        kind: "commit",
        detail: `commit ${first.toLowerCase().slice(0, 10)}`,
      };
    }
    return;
  } catch {
    /* Authored prose is not necessarily a URL. */
  }
}
