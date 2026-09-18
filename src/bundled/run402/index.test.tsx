// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { FRAME_SANDBOX, Run402Panel, SiteView, frameContext } from "./index";
import { parseRun402Site } from "./references";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const site = parseRun402Site("https://buzz-preview-demo.run402.com/todo?x=1#a");
assert.exists(site);
const noop = () => {};

it("checks the host before framing and never shows a frame while checking", () => {
  const html = renderToStaticMarkup(
    <Run402Panel target={site.url} close={noop} />,
  );
  expect(html).toContain("Checking whether buzz-preview-demo.run402.com");
  expect(html).not.toContain("<iframe");
});

it("frames the exact shared URL in a sandbox without top navigation", () => {
  const html = renderToStaticMarkup(
    <SiteView
      site={site}
      result={{ kind: "embeddable", projectId: "prj_1" }}
      retry={noop}
    />,
  );
  expect(html).toContain(
    'src="https://buzz-preview-demo.run402.com/todo?x=1#a"',
  );
  expect(html).toContain(`sandbox="${FRAME_SANDBOX}"`);
  expect(FRAME_SANDBOX).not.toContain("allow-top-navigation");
  expect(html.toLowerCase()).toContain(
    'referrerpolicy="strict-origin-when-cross-origin"',
  );
  expect(html).toContain('title="buzz-preview-demo.run402.com"');
  expect(html).toContain(
    'href="https://buzz-preview-demo.run402.com/todo?x=1#a"',
  );
  expect(html).toContain("Reload");
});

it("states plainly when a site cannot be embedded, with the manifest line that allows it", () => {
  const html = renderToStaticMarkup(
    <SiteView
      site={site}
      result={{ kind: "not-embeddable", projectId: "prj_2" }}
      retry={noop}
    />,
  );
  expect(html).not.toContain("<iframe");
  expect(html).toContain("doesn’t allow embedding");
  expect(html).toContain("Open in browser");
  expect(html).toContain("site.embedding.frame_ancestors");
  expect(html).toContain("prj_2");
});

it("distinguishes a host that is not a run402 project from a failed check", () => {
  const missing = renderToStaticMarkup(
    <SiteView site={site} result={{ kind: "not-run402" }} retry={noop} />,
  );
  expect(missing).not.toContain("<iframe");
  expect(missing).toContain("isn’t serving a run402 project");
  expect(missing).not.toContain('role="alert"');
  const failed = renderToStaticMarkup(
    <SiteView site={site} result="offline" retry={noop} />,
  );
  expect(failed).not.toContain("<iframe");
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("offline");
  expect(failed).toContain("Try again");
});

it("reloads by replacing the frame element for the same URL", async () => {
  render(
    <SiteView
      site={site}
      result={{ kind: "embeddable", projectId: "prj_1" }}
      retry={noop}
    />,
  );
  const before = screen.getByTitle("buzz-preview-demo.run402.com");
  expect(before).toHaveAttribute("src", site.url);
  await userEvent.click(screen.getByRole("button", { name: "Reload site" }));
  const after = screen.getByTitle("buzz-preview-demo.run402.com");
  expect(after).not.toBe(before);
  expect(after).toHaveAttribute("src", site.url);
  expect(before).not.toBeInTheDocument();
});

it("resolves the policy for the page origin and retries a failed check", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          project_id: "prj_9",
          embedding: { frame_ancestors: ["http://localhost:*"] },
        }),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  render(<Run402Panel target={site.url} close={noop} />);
  await screen.findByRole("alert");
  expect(fetch).toHaveBeenCalledWith(
    "https://buzz-preview-demo.run402.com/_run402/config.json",
    expect.objectContaining({ credentials: "omit" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(screen.getByTitle("buzz-preview-demo.run402.com")).toHaveAttribute(
      "src",
      site.url,
    ),
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("hands the conversation to the framed site, only to its origin, and only when known", () => {
  expect(frameContext(undefined, undefined)).toBeUndefined();
  expect(
    frameContext(
      { channelId: "alpha", canOpen: () => false, open: () => false },
      undefined,
    ),
  ).toEqual({ type: "buzz.context", version: 1, channelId: "alpha" });
  const buzz = frameContext(undefined, {
    scope: "s",
    channelId: "alpha",
    channelName: "Alpha",
    viewer: "f".repeat(64),
    relayUrl: "https://primary.example",
  });
  expect(buzz).toMatchObject({ channelId: "alpha", channelName: "Alpha" });
  render(
    <SiteView
      site={site}
      buzz={buzz}
      result={{ kind: "embeddable", projectId: "prj_1" }}
      retry={noop}
    />,
  );
  const frame = screen.getByTitle(
    "buzz-preview-demo.run402.com",
  ) as HTMLIFrameElement;
  assert.exists(frame.contentWindow);
  const post = vi.spyOn(frame.contentWindow, "postMessage");
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledWith(
    buzz,
    "https://buzz-preview-demo.run402.com",
  );
  post.mockClear();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "buzz.context.request", version: 1 },
      origin: "https://evil.example",
      source: frame.contentWindow,
    }),
  );
  expect(post).not.toHaveBeenCalled();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "buzz.context.request", version: 1 },
      origin: "https://buzz-preview-demo.run402.com",
      source: frame.contentWindow,
    }),
  );
  expect(post).toHaveBeenCalledTimes(1);
});

it("posts nothing into a frame opened without a conversation", () => {
  render(
    <SiteView
      site={site}
      result={{ kind: "embeddable", projectId: "prj_1" }}
      retry={noop}
    />,
  );
  const frame = screen.getByTitle(
    "buzz-preview-demo.run402.com",
  ) as HTMLIFrameElement;
  assert.exists(frame.contentWindow);
  const post = vi.spyOn(frame.contentWindow, "postMessage");
  fireEvent.load(frame);
  expect(post).not.toHaveBeenCalled();
});
