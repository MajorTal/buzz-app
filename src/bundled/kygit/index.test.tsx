// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, assert, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { FRAME_SANDBOX as SITE_SANDBOX } from "../run402";
import { FRAME_SANDBOX, KygitPanel, RepoView } from "./index";
import { parseKygitRepo } from "./references";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const file = parseKygitRepo(
  "https://git.run402.com/acme/api/blob/main/src/index.ts",
);
assert.exists(file);
const repo = parseKygitRepo("https://git.run402.com/acme/api");
assert.exists(repo);
const noop = () => {};
const embeddable = { kind: "embeddable", projectId: "prj_git" } as const;

it("checks the viewer host before framing and never shows a frame while checking", () => {
  const html = renderToStaticMarkup(
    <KygitPanel target={repo.url} close={noop} />,
  );
  expect(html).toContain("Checking whether git.run402.com");
  expect(html).not.toContain("<iframe");
});

it("frames the exact clicked URL in the site panel's sandbox, with popups allowed to escape it", () => {
  const html = renderToStaticMarkup(
    <RepoView link={file} result={embeddable} retry={noop} />,
  );
  expect(html).toContain(
    'src="https://git.run402.com/acme/api/blob/main/src/index.ts"',
  );
  expect(html).toContain(`sandbox="${FRAME_SANDBOX}"`);
  expect(FRAME_SANDBOX).toBe(SITE_SANDBOX);
  expect(FRAME_SANDBOX).toContain("allow-popups-to-escape-sandbox");
  expect(FRAME_SANDBOX).not.toContain("allow-top-navigation");
  expect(html.toLowerCase()).toContain(
    'referrerpolicy="strict-origin-when-cross-origin"',
  );
  expect(html).toContain("KyGit");
  expect(html).toContain("acme/api");
  expect(html).toContain("main · src/index.ts");
  expect(html).toContain(
    'href="https://git.run402.com/acme/api/blob/main/src/index.ts"',
  );
  expect(html).toContain("Reload");
  expect(html).not.toContain("verified");
});

it("states plainly when the viewer cannot be embedded or is not there, without a frame", () => {
  const denied = renderToStaticMarkup(
    <RepoView
      link={repo}
      result={{ kind: "not-embeddable", projectId: "prj_git" }}
      retry={noop}
    />,
  );
  expect(denied).not.toContain("<iframe");
  expect(denied).toContain("doesn’t allow embedding from this origin");
  expect(denied).toContain("Open in browser");
  expect(denied).not.toContain("site.embedding");
  const missing = renderToStaticMarkup(
    <RepoView link={repo} result={{ kind: "not-run402" }} retry={noop} />,
  );
  expect(missing).not.toContain("<iframe");
  expect(missing).toContain("isn’t serving Run402 Source");
  const failed = renderToStaticMarkup(
    <RepoView link={repo} result="offline" retry={noop} />,
  );
  expect(failed).not.toContain("<iframe");
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("Try again");
});

it("reloads by replacing the frame element for the same URL", async () => {
  render(<RepoView link={repo} result={embeddable} retry={noop} />);
  const before = screen.getByTitle("KyGit acme/api");
  await userEvent.click(
    screen.getByRole("button", { name: "Reload repository view" }),
  );
  const after = screen.getByTitle("KyGit acme/api");
  expect(after).not.toBe(before);
  expect(after).toHaveAttribute("src", repo.url);
  expect(before).not.toBeInTheDocument();
});

it("is a black box: posts nothing into the frame and listens for nothing", () => {
  const listen = vi.spyOn(window, "addEventListener");
  render(<RepoView link={repo} result={embeddable} retry={noop} />);
  const frame = screen.getByTitle("KyGit acme/api") as HTMLIFrameElement;
  assert.exists(frame.contentWindow);
  const post = vi.spyOn(frame.contentWindow, "postMessage");
  frame.dispatchEvent(new Event("load"));
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "buzz.context.request", version: 1 },
      origin: "https://git.run402.com",
      source: frame.contentWindow,
    }),
  );
  expect(post).not.toHaveBeenCalled();
  expect(listen.mock.calls.filter(([type]) => type === "message")).toHaveLength(
    0,
  );
});

it("reads the viewer's policy for the page origin without credentials and retries a failed check", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          project_id: "prj_git",
          embedding: { frame_ancestors: ["http://localhost:*"] },
        }),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  render(<KygitPanel target={file.url} close={noop} />);
  await screen.findByRole("alert");
  expect(fetch).toHaveBeenCalledWith(
    "https://git.run402.com/_run402/config.json",
    expect.objectContaining({ credentials: "omit" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(screen.getByTitle("KyGit acme/api")).toHaveAttribute(
      "src",
      file.url,
    ),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("ignores a target the matcher would never have accepted", () => {
  expect(
    renderToStaticMarkup(
      <KygitPanel target="https://git.run402.com/login" close={noop} />,
    ),
  ).toContain("Unsupported KyGit link");
});
