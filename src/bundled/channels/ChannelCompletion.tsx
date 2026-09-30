import { useLayoutEffect } from "react";
import { channelIcon } from "../../features/channels/channel-icon";
import type { ComposerCompletionProps } from "../../features/conversation/contracts";
import type { ChannelSummary } from "../../features/relay/contracts";

function eligible(channel: ChannelSummary, viewer: string | undefined) {
  return (
    !!viewer &&
    !!channel.name.trim() &&
    !/[\r\n]/.test(channel.name) &&
    !channel.archived &&
    !channel.cached &&
    !channel.readOnly &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    !!channel.members?.includes(viewer)
  );
}

export function ChannelCompletion({
  session,
  query,
  publish,
}: ComposerCompletionProps) {
  useLayoutEffect(() => {
    let withdraw: (() => void) | false | undefined;
    const update = () => {
      // Withdraw at the data boundary, not after a later React render.
      if (withdraw) withdraw();
      const list = session.channels.list();
      const needle = query.query.toLowerCase();
      const names = new Map<string, number>();
      const matches = list.channels
        .filter((channel) => eligible(channel, session.viewer))
        .flatMap((channel) => {
          const name = channel.name.toLowerCase();
          names.set(name, (names.get(name) ?? 0) + 1);
          if (!name.includes(needle)) return [];
          return [
            {
              channel,
              rank: name === needle ? 0 : name.startsWith(needle) ? 1 : 2,
            },
          ];
        })
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            a.channel.name.localeCompare(b.channel.name) ||
            a.channel.id.localeCompare(b.channel.id),
        );
      withdraw = publish({
        items: matches.slice(0, 20).map(({ channel }) => {
          const Icon = channelIcon(channel);
          const duplicate = (names.get(channel.name.toLowerCase()) ?? 0) > 1;
          const label = `#${channel.name}`.replace(
            /[\\`*_[\]()#<>~&]/g,
            "\\$&",
          );
          const id = encodeURIComponent(channel.id).replace(
            /[!'()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16)}`,
          );
          return {
            id: channel.id,
            label: channel.name,
            ...(duplicate || channel.private
              ? {
                  detail: [
                    channel.private ? "Private channel" : "",
                    duplicate ? channel.id : "",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }
              : {}),
            preview: <Icon size={22} />,
            edit: { text: `[${label}](buzz://channel/${id})` },
            canSelect: () =>
              session.channels
                .list()
                .channels.some(
                  (current) =>
                    current.id === channel.id &&
                    current.name === channel.name &&
                    eligible(current, session.viewer),
                ),
          };
        }),
        ...(list.error
          ? { status: "Could not refresh channels." }
          : !matches.length &&
              (list.status === "loading" || list.status === "idle")
            ? { status: "Loading channels…" }
            : matches.length > 20
              ? { status: "Keep typing to narrow the list." }
              : {}),
        ...(list.error && session.channels.refreshList
          ? { retry: () => session.channels.refreshList?.() }
          : {}),
      });
    };
    const unsubscribe = session.channels.subscribeList(update);
    update();
    return () => {
      unsubscribe();
      if (withdraw) withdraw();
    };
  }, [session, query.query, publish]);
  return null;
}
