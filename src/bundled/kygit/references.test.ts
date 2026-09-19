import { expect, it } from "vitest";
import { parseRun402Site } from "../run402/references";
import { parseKygitRepo } from "./references";

const accepted = [
  ["https://git.run402.com/acme/api", "repo", "acme/api", undefined],
  ["https://git.run402.com/acme/api/", "repo", "acme/api", undefined],
  [
    "https://git.run402.com/acme/api/blob/main/src/index.ts?x=1#L3",
    "file",
    "acme/api",
    "main · src/index.ts",
  ],
  [
    "https://git.run402.com/acme/api/blob/v1.0/docs/a%20b/c.md",
    "file",
    "acme/api",
    "v1.0 · docs/a b/c.md",
  ],
  [
    "https://git.run402.com/acme/api/commit/9F3C1A2B",
    "commit",
    "acme/api",
    "commit 9f3c1a2b",
  ],
  [
    "https://git.run402.com/repos/id/src_c78d2f710a8f49d22f9c66faf2a915cd",
    "repo",
    "vault src_c78d2f710a8f49d22f9c66faf2a915cd",
    undefined,
  ],
  [
    "https://git.run402.com/repos/id/src_c78d2f710a8f49d22f9c66faf2a915cd/blob/main/README.md",
    "file",
    "vault src_c78d2f710a8f49d22f9c66faf2a915cd",
    "main · README.md",
  ],
  [
    "https://git.run402.com/repos/id/src_c78d2f710a8f49d22f9c66faf2a915cd/commit/abcd1234abcd1234abcd1234abcd1234abcd1234",
    "commit",
    "vault src_c78d2f710a8f49d22f9c66faf2a915cd",
    "commit abcd1234ab",
  ],
] as const;

const rejected = [
  "https://git.run402.com/",
  "https://git.run402.com/login",
  "https://git.run402.com/auth/return",
  "https://git.run402.com/repos",
  "https://git.run402.com/repos/id",
  "https://git.run402.com/repos/acme",
  "https://git.run402.com/acme",
  "https://git.run402.com/acme/api/tree/main",
  "https://git.run402.com/acme/api/blob",
  "https://git.run402.com/acme/api/blob/main",
  "https://git.run402.com/acme/api/commit/zzz",
  "https://git.run402.com/acme/api/commit/abc",
  "https://git.run402.com/acme/api/commit/abcd1234/extra",
  "https://git.run402.com/Acme/api",
  "https://git.run402.com/acme/my_repo",
  "http://git.run402.com/acme/api",
  "https://git.run402.com:8443/acme/api",
  "https://user:pw@git.run402.com/acme/api",
  "https://GIT.run402.com.evil.example/acme/api",
  "https://kygit.com/acme/api",
  "https://console.run402.com/acme/api",
  "https://my-app.run402.com/acme/api",
  "not a url",
];

it("recognizes the viewer's six repo, file and commit shapes and keeps the shared URL intact", () => {
  for (const [url, kind, address, detail] of accepted) {
    const link = parseKygitRepo(url);
    expect(link, url).toBeDefined();
    expect(link?.kind, url).toBe(kind);
    expect(link?.address, url).toBe(address);
    expect(link?.detail, url).toBe(detail);
    expect(link?.host).toBe("git.run402.com");
  }
  expect(
    parseKygitRepo(
      "https://git.run402.com/acme/api/blob/main/src/index.ts?x=1#L3",
    )?.url,
  ).toBe("https://git.run402.com/acme/api/blob/main/src/index.ts?x=1#L3");
});

it("leaves the viewer's own pages, other forms and other hosts to ordinary link behavior", () => {
  for (const url of rejected) expect(parseKygitRepo(url), url).toBeUndefined();
});

it("never competes with the run402 site panel for a link", () => {
  for (const [url] of accepted)
    expect(parseRun402Site(url), url).toBeUndefined();
});
