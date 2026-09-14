import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AppServices } from "./services";
import { communityDestination } from "../features/communities/destination";
import type { OpenTarget } from "../features/navigation/targets";
import type { PageNavigation } from "../features/navigation/service";
import type { OpenFailure } from "../features/navigation/controller";
import { windowPages } from "../features/windows/service";
import { followSavedCommunity } from "../features/windows/follow";
import { orderPages } from "./shell/presentation";

const channelsKey = "buzz.channels/channels";
export function useAppNavigation(services: AppServices) {
  const navigation = services.navigation;
  const host = services.windows;
  const state = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const registry = useSyncExternalStore(
    services.pages.subscribe,
    services.pages.snapshot,
  );
  const windows = useSyncExternalStore(host.subscribe, host.snapshot);
  const pages = useMemo(
    () => windowPages(windows.layout, host.label, registry),
    [windows.layout, host.label, registry],
  );
  const plugins = useSyncExternalStore(
    services.plugins.subscribe,
    services.plugins.snapshot,
  );
  const startup = plugins.configuration.status;
  const target = state.entry.target;
  const scope = "scope" in target ? target.scope : undefined;
  const pageKey =
    target.kind === "page"
      ? `${target.pluginId}/${target.pageId}`
      : target.kind === "conversation"
        ? channelsKey
        : undefined;
  const page = pages.find((page) => page.key === pageKey);
  // A target that belongs to another window (or Home/Settings outside main) is
  // redirected to this window's first tab rather than reported as a failure.
  const redirecting =
    windows.status === "loading" ||
    ((host.isMain || pages.length > 0) &&
      ((!host.isMain &&
        (target.kind === "home" || target.kind === "settings")) ||
        (!!pageKey && !page && registry.some((item) => item.key === pageKey))));
  const membership = scope
    ? client.memberships.find(
        (item) => communityDestination(item.id).url === scope.communityOrigin,
      )
    : undefined;
  let failure: OpenFailure | undefined;
  let waiting = redirecting;
  if (scope === null) {
    waiting = client.status === "loading" || client.selected !== null;
  } else if (scope) {
    if (client.status === "loading") waiting = true;
    else if (client.viewer !== scope.viewer) failure = "denied";
    else if (!membership) failure = "denied";
    else if (client.selected !== membership.id) waiting = true;
  }
  if (pageKey && !failure) {
    if (startup === "loading") waiting = true;
    else if (
      plugins.activation[
        target.kind === "page" ? target.pluginId : "buzz.channels"
      ]?.status === "starting"
    )
      waiting = true;
    else if (!page) failure = "unavailable";
    else if (target.kind === "page" && target.route) {
      try {
        if (
          !page.route ||
          page.route.version !== target.route.version ||
          !page.route.validate(target.route.params)
        )
          failure = "unavailable";
      } catch {
        failure = "unavailable";
      }
    }
  }
  if (
    target.kind === "settings" &&
    target.section &&
    !["profile", "plugins", "appearance", "notifications"].includes(
      target.section,
    )
  )
    failure = "unavailable";
  const owner = useMemo(
    () => ({ attempt: state.attempt, page, waiting, failure }),
    [state.attempt, page, waiting, failure],
  );
  const [presentation, setPresentation] = useState<{
    owner: typeof owner;
    request: PageNavigation;
  }>();
  useLayoutEffect(() => {
    if (owner.waiting || owner.failure) return;
    const { request, dispose } = services.navigationHost.request(
      owner.attempt,
      {
        valid() {
          // Check exact registration identity at use time, before eventual React cleanup.
          if (owner.page && !services.pages.snapshot().includes(owner.page))
            return false;
          const target = owner.attempt.entry.target;
          if (!("scope" in target) || target.scope === undefined) return true;
          const client = services.communities.snapshot();
          if (client.status === "loading") return false;
          if (target.scope === null) return client.selected === null;
          const scope = target.scope;
          return (
            client.viewer === scope.viewer &&
            client.memberships.some(
              (item) =>
                item.id === client.selected &&
                communityDestination(item.id).url === scope.communityOrigin,
            )
          );
        },
        subscribe(listener) {
          const stopPages = services.pages.subscribe(listener);
          const stopClient = services.communities.subscribe(listener);
          return () => {
            stopPages();
            stopClient();
          };
        },
      },
    );
    setPresentation({ owner, request });
    return dispose;
  }, [services, owner]);
  const request =
    presentation?.owner === owner ? presentation.request : undefined;
  useEffect(() => {
    if (state.attempt.signal.aborted) return;
    if (failure) {
      services.navigationHost.complete(state.attempt, {
        status: "failed",
        reason: failure,
      });
      return;
    }
    if (
      scope === null &&
      client.status !== "loading" &&
      client.selected !== null
    )
      services.communities.select(null);
    if (
      scope &&
      client.status !== "loading" &&
      client.viewer === scope.viewer &&
      membership &&
      client.selected !== membership.id
    ) {
      services.communities.select(membership.id);
    }
  }, [services, state.attempt, failure, scope, client, membership]);
  useEffect(() => {
    if (!waiting && !failure && target.kind === "home")
      request?.complete({ status: "opened" });
  }, [waiting, failure, target, request]);
  const select = (key: string, options?: { replace?: boolean }) => {
    const selectedClient = services.communities.snapshot();
    let destination: OpenTarget;
    if (key === "home") destination = { version: 1, kind: "home" };
    else if (key === "settings") destination = { version: 1, kind: "settings" };
    else {
      const selected = pages.find((page) => page.key === key);
      if (!selected) return;
      destination = {
        version: 1,
        kind: "page",
        pluginId: selected.pluginId,
        pageId: selected.id,
        ...(selectedClient.viewer && selectedClient.selected
          ? {
              scope: {
                viewer: selectedClient.viewer,
                communityOrigin: communityDestination(selectedClient.selected)
                  .url,
              },
            }
          : { scope: null }),
      };
    }
    void navigation.open(destination, options);
  };
  const latest = useRef({ select, pageKey });
  latest.current = { select, pageKey };
  const first = orderPages(pages)[0]?.key;
  useEffect(() => {
    if (!redirecting || windows.status === "loading" || startup !== "ready")
      return;
    if (first) latest.current.select(first, { replace: true });
    else if (host.isMain) latest.current.select("home", { replace: true });
    // A detached window without pages shows its empty state instead.
  }, [redirecting, windows.status, startup, first, host.isMain]);
  useEffect(() => {
    if (host.isMain || !client.viewer) return;
    return followSavedCommunity(client.viewer, (selected) => {
      const current = services.communities.snapshot();
      if (selected === current.selected) return;
      // A community joined in another window needs a relaunch of this one to follow.
      if (selected && !current.memberships.some((m) => m.id === selected))
        return;
      services.communities.select(selected);
      const { pageKey, select } = latest.current;
      if (pageKey) select(pageKey, { replace: true });
    });
  }, [host.isMain, client.viewer, services]);
  return {
    state,
    target,
    pages,
    page,
    request,
    select,
    waiting,
    redirecting,
    failure,
    selected: pageKey ?? target.kind,
    retry() {
      // Retrying presentation must also repair its failed dependency. Only touch the
      // selected, authorized destination; never reconnect an unrelated community.
      if (pageKey === channelsKey && !failure && !waiting) {
        const status = services.relay.snapshot().status;
        if (status === "error" || status === "disconnected")
          services.relay.retry();
      }
      void navigation.retry();
    },
  };
}
