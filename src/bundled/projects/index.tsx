import type { PluginModule } from "../../plugins/api";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";

export const inject = ["pages"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "projects",
    title: "Projects",
    layout: "workspace",
    component: ProjectsPage,
  });
};

function ProjectsPage() {
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Projects">
        <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-6 text-center">
          <h1 className="m-0 text-3xl font-medium tracking-tight">Projects</h1>
        </div>
      </FullPageSurface>
    </div>
  );
}
