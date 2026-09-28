import type { GitHubReference } from "./references";

export type GitHubDetails = {
  title: string;
  body: string;
  bodyHtml?: string | undefined;
  state: string;
  author: string;
  facts: [string, string | number][];
};
type ResponseData = {
  title?: string;
  description?: string | null;
  body?: string | null;
  body_html?: string | null;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  user?: { login: string };
  owner?: { login: string };
  author?: { login: string };
  commit?: { message: string; author: { name: string } };
  base?: { label: string };
  head?: { label: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  stargazers_count?: number;
  language?: string | null;
  default_branch?: string;
};

export async function loadGitHubDetails(
  reference: GitHubReference,
  signal: AbortSignal,
): Promise<GitHubDetails> {
  const url = new URL(reference.url);
  const id = url.pathname.split("/").at(-1);
  const surface = {
    repository: "",
    pull: `/pulls/${id}`,
    issue: `/issues/${id}`,
    commit: `/commits/${id}`,
  }[reference.kind];
  const response = await fetch(
    `https://api.github.com/repos/${reference.repository}${surface}`,
    {
      signal,
      headers: { Accept: "application/vnd.github.full+json" },
      credentials: "omit",
    },
  );
  if (!response.ok) {
    if (response.status === 404)
      throw new Error(
        "This object is private or unavailable. Open it on GitHub to use your signed-in account.",
      );
    if (response.status === 403 || response.status === 429)
      throw new Error(
        "GitHub’s public API limit was reached. Try again later or open it on GitHub.",
      );
    throw new Error(`GitHub couldn’t load this object (${response.status}).`);
  }
  const data: ResponseData = await response.json();
  const facts: GitHubDetails["facts"] = [];
  if (data.head && data.base)
    facts.push(["Branch", `${data.head.label} → ${data.base.label}`]);
  if (data.changed_files !== undefined)
    facts.push(["Files changed", data.changed_files]);
  if (data.additions !== undefined && data.deletions !== undefined)
    facts.push(["Changes", `+${data.additions} / −${data.deletions}`]);
  if (data.comments !== undefined) facts.push(["Comments", data.comments]);
  if (data.stargazers_count !== undefined)
    facts.push(["Stars", data.stargazers_count]);
  if (data.language) facts.push(["Language", data.language]);
  if (data.default_branch) facts.push(["Default branch", data.default_branch]);
  const [commitTitle, ...commitBody] = data.commit?.message.split("\n") ?? [];
  return {
    title: data.title ?? commitTitle ?? reference.repository,
    body: data.body ?? data.description ?? commitBody.join("\n").trim(),
    bodyHtml: data.body_html ?? undefined,
    state: data.merged ? "Merged" : data.draft ? "Draft" : (data.state ?? ""),
    author:
      data.user?.login ??
      data.author?.login ??
      data.commit?.author.name ??
      data.owner?.login ??
      "",
    facts,
  };
}
