export type Run402Site = Readonly<{
  /** The clicked URL, unchanged: path, query and hash are what the author shared. */
  url: string;
  host: string;
  label: string;
}>;

const tenantSuffixes = [".run402.com", ".run402.app"] as const;
/** Platform surfaces are never tenant sites, whatever their release says. */
const platformLabels = new Set([
  "www",
  "api",
  "console",
  "git",
  "docs",
  "admin",
  "status",
]);
const label = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Exact tenant-host parsing: a lookalike domain, port or credentials never become a site panel. */
export function parseRun402Site(value: string): Run402Site | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password)
      return;
    const suffix = tenantSuffixes.find((candidate) =>
      url.hostname.endsWith(candidate),
    );
    if (!suffix) return;
    const name = url.hostname.slice(0, -suffix.length);
    if (!label.test(name) || platformLabels.has(name)) return;
    return { url: url.href, host: url.hostname, label: name };
  } catch {
    /* Authored prose is not necessarily a URL. */
  }
}
