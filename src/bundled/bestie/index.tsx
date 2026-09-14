import type { PluginModule } from "../../plugins/api";

export const inject = ["panels"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "companion",
    title: "Bestie",
    matches: () => false,
    launcher: { icon: "/bestie.png", target: "" },
    component: Bestie,
  });
};

function Bestie() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <img src="/bestie.png" alt="" className="size-20 object-contain" />
      <h2 className="text-heading">Meet your Bestie</h2>
      <p className="max-w-xs text-body-sm text-muted">
        Your companion’s home in Buzz. Agent chat isn’t connected yet.
      </p>
    </div>
  );
}
