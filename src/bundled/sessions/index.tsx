import type { PluginModule } from "../../plugins/api";
import { SessionsPage } from "./SessionsPage";

export const inject = ["pages", "relay", "conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const extensions = ctx.conversation;
  ctx.pages.register({
    id: "sessions",
    title: "Sessions",
    layout: "workspace",
    component: () => <SessionsPage relay={relay} extensions={extensions} />,
  });
};
