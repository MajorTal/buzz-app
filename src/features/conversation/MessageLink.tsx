import {
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type MouseEvent,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type { ContributionReader, LinkRenderer } from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import type { RelaySession } from "../relay/session";
import { parseBuzzLink, isBuzzLink } from "../navigation/buzz-links";
import { LinkLabelContext, LinkContentContext } from "./LinkLabelContext";
import { BuzzLinkPreview } from "./BuzzLinkPreview";
import { messageViewKey } from "../messages/view-key";
import styles from "./LinkPreview.module.css";

const empty: readonly Contribution<LinkRenderer>[] = [];
const snapshot = () => empty;
const subscribe = () => () => {};

/** First active match wins, like panels. A broken matcher leaves other candidates eligible. */
export function resolveLink(
  url: string,
  renderers: readonly Contribution<LinkRenderer>[],
) {
  for (const renderer of renderers) {
    try {
      if (renderer.matches(url)) return renderer;
    } catch {
      // An optional renderer must not prevent opening a link.
    }
  }
  return undefined;
}

export function MessageLink({
  url,
  children,
  registry,
  onOpenLink,
  label,
  session,
  scope,
  interactive = true,
}: {
  url: string;
  children?: ReactNode;
  registry: ContributionReader<LinkRenderer> | undefined;
  onOpenLink(url: string): boolean;
  label?: string | undefined;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  interactive?: boolean;
}) {
  const renderers = useSyncExternalStore(
    registry?.subscribe ?? subscribe,
    registry?.snapshot ?? snapshot,
    registry?.snapshot ?? snapshot,
  );
  const renderer = resolveLink(url, renderers);
  const [unavailable, setUnavailable] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const trigger = useRef<HTMLAnchorElement>(null);
  const internal = isBuzzLink(url);
  const parsed = internal ? parseBuzzLink(url) : null;
  const destination =
    parsed?.format === "legacy"
      ? parsed
      : parsed?.target.kind === "conversation" &&
          scope?.slice(0, -65) === parsed.target.scope.communityOrigin
        ? parsed.target
        : undefined;
  const preview =
    session && destination?.messageId
      ? { channelId: destination.channelId, messageId: destination.messageId }
      : undefined;
  const navigation = {
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (internal) {
        event.preventDefault();
        if (trigger.current?.isConnected)
          trigger.current.focus({ preventScroll: true });
        const opened = onOpenLink(url);
        setUnavailable(!opened);
        if (opened) setPreviewOpen(false);
        return;
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        onOpenLink(url)
      )
        event.preventDefault();
    },
    onAuxClick: internal
      ? (event: MouseEvent<HTMLAnchorElement>) => {
          if (event.button === 1) {
            event.preventDefault();
            if (trigger.current?.isConnected)
              trigger.current.focus({ preventScroll: true });
            const opened = onOpenLink(url);
            setUnavailable(!opened);
            if (opened) setPreviewOpen(false);
          }
        }
      : undefined,
  };
  const anchor = (entry?: Contribution<LinkRenderer>) => {
    const Content = entry?.component;
    const content = Content ? (
      <Content url={url} />
    ) : (
      (children ?? label ?? url)
    );
    const element = interactive ? (
      <a
        ref={trigger}
        href={url}
        aria-label={label}
        title={!preview ? url : undefined}
        className={entry?.className}
        data-link-renderer={entry?.key}
        {...navigation}
      >
        {content}
      </a>
    ) : (
      <span className={entry?.className} data-link-renderer={entry?.key}>
        {content}
      </span>
    );
    return interactive && preview && session ? (
      <PreviewCard
        trigger={element}
        link={<a href={url} {...navigation} />}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        side="top"
        className={styles.popup ?? ""}
        aria-label="Message preview"
      >
        {previewOpen && (
          <BuzzLinkPreview
            key={messageViewKey(session, scope, url)}
            session={session}
            channelId={preview.channelId}
            messageId={preview.messageId}
          />
        )}
      </PreviewCard>
    ) : (
      element
    );
  };
  const link = renderer ? (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${url}`}
      fallback={anchor()}
    >
      {anchor(renderer)}
    </ContributionBoundary>
  ) : (
    anchor()
  );
  const result = (
    <>
      {link}
      {unavailable && (
        <span role="status"> This Buzz link couldn’t be opened here.</span>
      )}
    </>
  );
  return (
    <LinkLabelContext value={label}>
      <LinkContentContext value={children}>{result}</LinkContentContext>
    </LinkLabelContext>
  );
}
