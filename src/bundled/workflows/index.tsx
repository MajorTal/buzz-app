import type { PluginModule } from "../../plugins/api";
import { WorkflowsPage } from "./WorkflowsPage";
export const inject = ["pages", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.pages.register({
    id: "workflows",
    title: "Workflows",
    layout: "workspace",
    component: () => <WorkflowsPage relay={relay} />,
  });
};
