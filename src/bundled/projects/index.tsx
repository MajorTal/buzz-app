import type { PluginModule } from "../../plugins/api";
import { parseEntityRoute } from "../../features/projects/routes";
import { ProjectsPage } from "./ProjectsPage";
import { ResourcePicker } from "./ResourcePicker";

export const inject = ["pages", "relay", "navigation", "conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "projects",
    title: "Projects",
    layout: "workspace",
    handlesNavigation: true,
    route: {
      version: 1,
      validate: (params) => parseEntityRoute(params) !== null,
    },
    component: (props) => (
      <ProjectsPage {...props} relay={ctx.relay} open={ctx.navigation.open} />
    ),
  });
  ctx.conversation.registerTool({
    id: "resources",
    title: "Issues and pull requests",
    component: ResourcePicker,
  });
};
