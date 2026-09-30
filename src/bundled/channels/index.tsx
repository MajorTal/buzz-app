import { ChannelCompletion } from "./ChannelCompletion";
import { channelQuery } from "./channel-query";
import { isChannelRoute } from "../../features/channel-navigation/routes";
import type { PluginModule } from "../../plugins/api";
import { ChannelsPage } from "./ChannelsPage";
import { ChannelSetupSettings } from "./ChannelSetupSettings";
export const inject = [
  "pages",
  "agentControl",
  "relay",
  "panels",
  "conversation",
  "navigation",
  "settingsCards",
  "channelTemplates",
];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerCompletion({
    id: "channel-typeahead",
    title: "Channel",
    match: ({ text, start }) => channelQuery(text, start),
    component: ChannelCompletion,
  });
  const extensions = ctx.conversation;
  const agentControl = ctx.agentControl;
  const relay = ctx.relay;
  const panels = ctx.panels;
  const pages = ctx.pages;
  const navigator = ctx.navigation;
  const providers = ctx.channelTemplates;
  ctx.settingsCards.register({
    id: "groups",
    title: "Personal groups",
    component: ({ active }) => (
      <ChannelSetupSettings
        relay={relay}
        providers={providers}
        active={active}
      />
    ),
  });
  ctx.pages.register({
    id: "channels",
    title: "Channels",
    layout: "workspace",
    companion: true,
    handlesNavigation: true,
    route: { version: 1, validate: isChannelRoute },
    component: ({ companion, navigation }) => (
      <ChannelsPage
        agentControl={agentControl}
        providers={providers}
        navigation={navigation}
        navigator={navigator}
        extensions={extensions}
        relay={relay}
        panels={panels}
        pages={pages}
        companion={companion}
      />
    ),
  });
};
