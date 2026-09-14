import type { Communities } from "../communities/service";
import { communityDestination } from "../communities/destination";
import type { OpenTarget } from "../navigation/targets";
import type { IncomingListener } from "../relay/incoming";
import type { RelaySession } from "../relay/session";
import type { NotificationsService } from "./service";
import { messageNotificationText } from "./content";

const labels = {
  mention: "Mentions",
  direct: "Direct messages",
  thread: "Thread replies",
};
/** No new subscriptions: this first adapter covers only the selected community. */
export function notificationAuthorized(
  communities: Communities,
  target: OpenTarget,
) {
  if (!("scope" in target) || !target.scope) return true;
  const client = communities.snapshot();
  const scope = target.scope;
  if (
    client.viewer !== scope.viewer ||
    !client.memberships.some(
      (item) => communityDestination(item.id).url === scope.communityOrigin,
    )
  )
    return false;
  if (target.kind !== "conversation") return true;
  const relay = communities.relay.snapshot();
  return (
    !!client.selected &&
    communityDestination(client.selected).url === scope.communityOrigin &&
    relay.status === "ready" &&
    relay.viewer === scope.viewer &&
    relay.session.channels
      .list()
      .channels.some(
        (channel) =>
          channel.id === target.channelId &&
          channel.members?.includes(scope.viewer),
      )
  );
}

export function bindMessageNotifications(
  notifications: NotificationsService,
  communities: Communities,
) {
  let closed = false;
  let session: RelaySession | undefined;
  let identity = "";
  let generation = 0;
  let stopIncoming = () => {};
  let stopAccess = () => {};
  let stopSync = () => {};
  const update = () => {
    const client = communities.snapshot();
    void notifications.selectViewer(client.viewer);
    const relay = communities.relay.snapshot();
    const origin = client.selected
      ? communityDestination(client.selected).url
      : undefined;
    const next = `${client.viewer ?? ""}:${origin ?? ""}:${relay.status}`;
    if (session === relay.session && identity === next) return;
    generation++;
    stopIncoming();
    stopAccess();
    stopSync();
    notifications.revalidate();
    session = relay.session;
    identity = next;
    if (
      closed ||
      relay.status !== "ready" ||
      !origin ||
      !client.viewer ||
      relay.viewer !== client.viewer
    )
      return;
    const viewer = client.viewer;
    const owned = relay.session;
    const current = generation;
    const valid = () =>
      !closed &&
      generation === current &&
      communities.relay.snapshot().session === owned;
    const receive: IncomingListener = (messages) => {
      for (const message of messages) {
        if (!valid()) return;
        const age = Date.now() - message.createdAt * 1000;
        if (age < -30000 || age > 120000) continue;
        const attention = owned.unread.attention(
          message.channelId,
          message.messageId,
        );
        const category = attention.category;
        if (attention.status !== "eligible" || !category) continue;
        void notifications.admit(
          category,
          labels[category],
          {
            sourceKey: message.messageId,
            target: {
              version: 1,
              kind: "conversation",
              scope: { viewer, communityOrigin: origin },
              channelId: message.channelId,
              messageId: message.messageId,
              ...(attention.rootId ? { threadRootId: attention.rootId } : {}),
            },
          },
          valid,
          () => {
            if (!valid() || Date.now() - message.createdAt * 1000 > 120000)
              return false;
            const attention = owned.unread.attention(
              message.channelId,
              message.messageId,
            );
            const sync = owned.unread.sync();
            if (
              attention.status === "ineligible" ||
              (!notifications.snapshot().preferences.notifyWhileViewing &&
                attention.viewing)
            )
              return false;
            if (
              sync.status === "loading" ||
              sync.status === "error" ||
              (sync.capability !== "unsupported" &&
                sync.completeness === "unknown") ||
              attention.status === "unknown"
            )
              return "wait";
            return attention.unread;
          },
          () =>
            messageNotificationText(
              message,
              category,
              owned.channels
                .list()
                .channels.find((item) => item.id === message.channelId),
              owned.profiles.snapshot().get(message.authorId),
            ),
        );
      }
    };
    stopIncoming = owned.subscribeIncoming(receive);
    // Only reconsider retained live candidates; readiness is not an event source.
    stopSync = owned.unread.subscribeSync(() => notifications.revalidate());
    // App-global ownership: Channels may not be mounted. Start its shared
    // observation only after discovery, so an empty startup roster cannot
    // consume the unread owner's one-shot evidence repair.
    const accessChanged = () => {
      notifications.revalidate();
      if (
        owned.channels.list().status === "ready" &&
        owned.unread.sync().capability !== "unsupported"
      )
        void owned.unread.ensure();
    };
    stopAccess = owned.channels.subscribeList(accessChanged);
    accessChanged();
  };
  const stop = communities.relay.subscribe(update);
  const stopCommunities = communities.subscribe(update);
  update();
  return () => {
    closed = true;
    generation++;
    stop();
    stopCommunities();
    stopIncoming();
    stopAccess();
    stopSync();
  };
}
