import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/Avatar";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import { Button } from "../../shared/design-system/ui/Button";
import { parseRun402Site, type Run402Site } from "./references";
import { loadEmbeddingPolicy, type EmbeddingPolicy } from "./config";
import {
  parseNostrBindRequest,
  type NostrBindError,
  type NostrBindPrompt,
  type NostrBindRequest,
  type NostrBindResult,
} from "./nostr-bind";
import {
  signNostrBind,
  type NostrBindEvent,
  type NostrBindTags,
} from "../../features/identity/nostr-bind";
import { nativeIdentityEnabled } from "../../features/identity/service";
import type { RelayData } from "../../features/relay/service";
import { npubEncode } from "nostr-tools/nip19";
import styles from "./Run402.module.css";

export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const signIn: SignIn = {
    // Only the dev broker signs sign-in bindings; native identity has no signer yet.
    sign: nativeIdentityEnabled() ? undefined : signNostrBind,
    viewer: () => viewer(ctx.relay),
  };
  ctx.panels.register({
    id: "site",
    title: "Run402",
    matches: (target) => !!parseRun402Site(target),
    component: (props) => <Run402Panel {...props} signIn={signIn} />,
  });
};

/** The host's half of "Sign in with Buzz" (docs/run402-sign-in.md). */
export type SignIn = Readonly<{
  sign: ((tags: NostrBindTags) => Promise<NostrBindEvent>) | undefined;
  viewer(): Viewer;
}>;
export type Viewer = Readonly<{ name: string; picture?: string | undefined }>;

function viewer(relay: RelayData): Viewer {
  const { viewer, session } = relay.snapshot();
  if (!viewer) return { name: "your Buzz identity" };
  const profile = session.profiles.snapshot().get(viewer);
  return {
    name: profile?.name.trim() || `${npubEncode(viewer).slice(0, 12)}…`,
    // Relay-hosted pictures need the session's media access, as elsewhere in the app.
    picture: profile?.picture && session.media(profile.picture, "small"),
  };
}

/** Sandbox for a cross-origin tenant site: its own origin, scripts and forms; never the top window. */
export const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

/**
 * Public presentation context handed to a framed site: which conversation it
 * was opened from and, when a channel presentation supplies it, who is looking.
 * Claimed, not proven: the site must treat it as display metadata.
 */
export type BuzzFrameContext = Readonly<{
  type: "buzz.context";
  version: 1;
  channelId: string;
  channelName?: string;
  viewer?: string;
  relayUrl?: string;
}>;

export function frameContext(
  context: PanelProps["context"],
  channelContext: PanelProps["channelContext"],
): BuzzFrameContext | undefined {
  const channelId = channelContext?.channelId ?? context?.channelId;
  if (!channelId) return;
  return {
    type: "buzz.context",
    version: 1,
    channelId,
    ...(channelContext?.channelName
      ? { channelName: channelContext.channelName }
      : {}),
    ...(channelContext?.viewer ? { viewer: channelContext.viewer } : {}),
    ...(channelContext?.relayUrl ? { relayUrl: channelContext.relayUrl } : {}),
  };
}

export function Run402Panel({
  target,
  context,
  channelContext,
  signIn,
}: PanelProps & { signIn?: SignIn }) {
  const [attempt, retry] = useState(0);
  const site = useMemo(() => parseRun402Site(target), [target]);
  const buzz = useMemo(
    () => frameContext(context, channelContext),
    [context, channelContext],
  );
  return site ? (
    <SitePanel
      key={`${site.url}:${attempt}`}
      site={site}
      buzz={buzz}
      signIn={signIn}
      retry={() => retry(attempt + 1)}
    />
  ) : (
    <p className="notice">Unsupported run402 link.</p>
  );
}

function SitePanel({
  site,
  buzz,
  signIn,
  retry,
}: {
  site: Run402Site;
  buzz: BuzzFrameContext | undefined;
  signIn: SignIn | undefined;
  retry(): void;
}) {
  const [result, setResult] = useState<EmbeddingPolicy | string>();
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void loadEmbeddingPolicy(
      site.host,
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
  }, [site]);
  return (
    <SiteView
      site={site}
      buzz={buzz}
      signIn={signIn}
      result={result}
      retry={retry}
    />
  );
}

/** Presentation for every state; only `embeddable` renders a frame. */
export function SiteView({
  site,
  buzz,
  signIn,
  result,
  retry,
}: {
  site: Run402Site;
  buzz?: BuzzFrameContext | undefined;
  signIn?: SignIn | undefined;
  result: EmbeddingPolicy | string | undefined;
  retry(): void;
}) {
  const [reloads, reload] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = useMemo(() => new URL(site.url).origin, [site.url]);
  const post = () => {
    if (buzz && frame.current?.contentWindow)
      frame.current.contentWindow.postMessage(buzz, origin);
  };
  // One sign-in request at a time; the ref answers bursts before React re-renders.
  const [consent, setConsent] = useState<Consent>();
  const pending = useRef<Consent>(undefined);
  const answered = useRef(new Set<string>());
  const settle = (next?: Consent) => {
    pending.current = next;
    setConsent(next);
  };
  const reply = (
    challengeId: string,
    outcome: { event: NostrBindEvent } | { error: NostrBindError },
  ) => {
    const result: NostrBindResult = {
      type: "buzz.nostr-bind.result",
      version: 1,
      challengeId,
      ...outcome,
    };
    frame.current?.contentWindow?.postMessage(result, origin);
  };
  const approve = async (request: Consent) => {
    settle({ ...request, busy: true });
    let outcome: { event: NostrBindEvent } | { error: NostrBindError };
    if (Date.parse(request.expiresAt) <= Date.now())
      outcome = { error: "expired" };
    else
      try {
        outcome = signIn?.sign
          ? { event: await signIn.sign(request.tags) }
          : { error: "unavailable" };
      } catch {
        outcome = { error: "unavailable" };
      }
    // A reload or newer render retired this request; its document gets nothing.
    if (pending.current?.challengeId !== request.challengeId) return;
    settle();
    reply(request.challengeId, outcome);
  };
  // The site may boot before or after the load event; answer its request too.
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (
        event.origin !== origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      if (event.data?.type === "buzz.context.request") return post();
      if (
        event.data?.type !== "buzz.nostr-bind.request" ||
        event.data.version !== 1
      )
        return;
      const request = parseNostrBindRequest(
        event.data.deepLink,
        origin,
        Date.now(),
      );
      if (!request || answered.current.has(request.challengeId)) return;
      answered.current.add(request.challengeId);
      if ("error" in request)
        reply(request.challengeId, { error: request.error });
      else if (pending.current || !signIn?.sign)
        reply(request.challengeId, { error: "unavailable" });
      else {
        settle({ ...request, viewer: signIn.viewer() });
        // Tells the site the bar is up, so it can tell "no Buzz host" from "not tapped yet".
        const prompt: NostrBindPrompt = {
          type: "buzz.nostr-bind.prompt",
          version: 1,
          challengeId: request.challengeId,
        };
        frame.current?.contentWindow?.postMessage(prompt, origin);
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  });
  if (result === undefined)
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <p role="status">Checking whether {site.host} allows embedding…</p>
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
        <OpenInBrowser site={site} block />
      </div>
    );
  if (result.kind === "not-run402")
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <p>
          {site.host} isn’t serving a run402 project right now, so there is
          nothing to show here.
        </p>
        <OpenInBrowser site={site} block />
      </div>
    );
  if (result.kind === "not-embeddable")
    return (
      <div className={`${styles.root} ${styles.text}`}>
        <p>This app doesn’t allow embedding in Buzz.</p>
        <OpenInBrowser site={site} block />
        <p className={styles.note}>
          To allow it, deploy the site with{" "}
          <code>site.embedding.frame_ancestors: ["localhost"]</code>. Project{" "}
          <code>{result.projectId}</code>.
        </p>
      </div>
    );
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.host} title={site.url}>
          {site.host}
        </span>
        <Button
          variant="ghost"
          size="compact"
          aria-label="Reload site"
          onClick={() => {
            settle();
            reload(reloads + 1);
          }}
        >
          <ArrowClockwiseIcon size={14} /> Reload
        </Button>
        <OpenInBrowser site={site} />
      </div>
      {/* The sign-in card floats over the site so the page never shifts under it. */}
      <div className={styles.stage}>
        {consent && (
          <section className={styles.consent} aria-label="Sign-in request">
            <Avatar
              name={consent.viewer.name}
              src={consent.viewer.picture}
              className="size-8"
            />
            <div className={styles.consentMain}>
              <Button
                variant="primary"
                size="compact"
                autoFocus
                loading={!!consent.busy}
                disabled={!!consent.busy}
                onClick={() => void approve(consent)}
              >
                Continue as {consent.viewer.name}
              </Button>
              <p>to {new URL(origin).host}</p>
            </div>
            <Button
              variant="ghost"
              size="compact"
              aria-label="Dismiss sign-in"
              disabled={!!consent.busy}
              onClick={() => {
                settle();
                reply(consent.challengeId, { error: "declined" });
              }}
            >
              <XIcon size={14} />
            </Button>
          </section>
        )}
        <iframe
          key={reloads}
          ref={frame}
          onLoad={post}
          className={styles.frame}
          src={site.url}
          title={site.host}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="strict-origin-when-cross-origin"
          allow=""
        />
      </div>
    </div>
  );
}

type Consent = NostrBindRequest & { viewer: Viewer; busy?: boolean };

function OpenInBrowser({ site, block }: { site: Run402Site; block?: boolean }) {
  return (
    <a
      className={block ? styles.external : styles.open}
      href={site.url}
      target="_blank"
      rel="noreferrer"
    >
      Open in browser <ArrowSquareOutIcon size={14} />
    </a>
  );
}
