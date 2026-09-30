// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  act,
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

const siteOrigin = "https://buzz-preview-demo.run402.com";
function bindRequest(challenge: string, origin = siteOrigin) {
  const url = new URL("buzz://nostr-bind");
  for (const [name, value] of Object.entries({
    challenge_id: challenge,
    nonce: "n".repeat(43),
    verification_code: "123456",
    audience: "buzz:nostr-identity",
    action: "bind_nostr_identity",
    protocol: "buzz-nostr-identity",
    version: "1",
    origin,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    return: "browser_fragment_v1",
    callback_url: `${origin}/callback`,
  }))
    url.searchParams.set(name, value);
  return { type: "buzz.nostr-bind.request", version: 1, deepLink: url.href };
}
const challengeA = "0f8fad5b-d9cb-469f-a165-70867728950e";
const challengeB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
function renderSignIn(sign?: (tags: unknown) => Promise<never>) {
  assert.exists(site);
  render(
    <SiteView
      site={site}
      signIn={{ sign, viewer: () => ({ name: "Tal" }) }}
      result={{ kind: "embeddable", projectId: "prj_1" }}
      retry={noop}
    />,
  );
  const frame = screen.getByTitle(
    "buzz-preview-demo.run402.com",
  ) as HTMLIFrameElement;
  assert.exists(frame.contentWindow);
  const source = frame.contentWindow;
  const post = vi.spyOn(source, "postMessage");
  const send = (data: unknown, origin = siteOrigin, from: Window = source) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data, origin, source: from }),
      );
    });
  return { post, send };
}

it("asks before signing a framed site in and answers only that origin", async () => {
  const signed = { id: "e", kind: 24243 };
  let release!: (event: unknown) => void;
  const sign = vi.fn(
    (_tags: unknown) =>
      new Promise<never>((resolve) => {
        release = resolve as (event: unknown) => void;
      }),
  );
  const { post, send } = renderSignIn(sign);
  // Without channel context, but never from another origin or window.
  send(bindRequest(challengeA), "https://evil.example");
  send(bindRequest(challengeA), siteOrigin, window);
  expect(screen.queryByRole("region", { name: "Sign-in request" })).toBeNull();
  send(bindRequest(challengeA));
  const bar = screen.getByRole("region", { name: "Sign-in request" });
  expect(bar).toHaveTextContent(`Continue as Tal`);
  expect(bar).toHaveTextContent(`to ${new URL(siteOrigin).host}`);
  expect(sign).not.toHaveBeenCalled();
  // One request at a time; a repeated challenge is not asked twice.
  send(bindRequest(challengeB));
  send(bindRequest(challengeA));
  expect(post.mock.calls).toEqual([
    [
      { type: "buzz.nostr-bind.prompt", version: 1, challengeId: challengeA },
      siteOrigin,
    ],
    [
      {
        type: "buzz.nostr-bind.result",
        version: 1,
        challengeId: challengeB,
        error: "unavailable",
      },
      siteOrigin,
    ],
  ]);
  post.mockClear();
  await userEvent.click(
    screen.getByRole("button", { name: "Continue as Tal" }),
  );
  expect(sign).toHaveBeenCalledTimes(1);
  expect(sign.mock.calls[0]?.[0]).toContainEqual(["origin", siteOrigin]);
  expect(
    screen.getByRole("button", { name: "Dismiss sign-in" }),
  ).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
  release(signed);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      {
        type: "buzz.nostr-bind.result",
        version: 1,
        challengeId: challengeA,
        event: signed,
      },
      siteOrigin,
    ),
  );
  expect(screen.queryByRole("region", { name: "Sign-in request" })).toBeNull();
});

it("declines without signing, and answers invalid or unsigned requests at once", async () => {
  const sign = vi.fn();
  const { post, send } = renderSignIn(sign);
  send(bindRequest(challengeA));
  await userEvent.click(
    screen.getByRole("button", { name: "Dismiss sign-in" }),
  );
  expect(sign).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(
    {
      type: "buzz.nostr-bind.result",
      version: 1,
      challengeId: challengeA,
      error: "declined",
    },
    siteOrigin,
  );
  post.mockClear();
  send(bindRequest(challengeA));
  expect(post).not.toHaveBeenCalled();
  send(bindRequest(challengeB, "https://evil.run402.com"));
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ challengeId: challengeB, error: "invalid" }),
    siteOrigin,
  );
  expect(screen.queryByRole("region", { name: "Sign-in request" })).toBeNull();
  cleanup();
  const unsigned = renderSignIn(undefined);
  unsigned.send(bindRequest(challengeA));
  expect(unsigned.post).toHaveBeenCalledWith(
    expect.objectContaining({ challengeId: challengeA, error: "unavailable" }),
    siteOrigin,
  );
  expect(screen.queryByRole("region", { name: "Sign-in request" })).toBeNull();
});
