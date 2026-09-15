import { DoorOpen } from "lucide-react";
import type { PluginModule } from "../../plugins/api";
import { RoomsPanel } from "./RoomsPanel";

export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.panels.register({
    id: "live-rooms",
    title: "Live rooms",
    matches: () => false,
    launcher: {
      icon: `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#f2f2f2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/></svg>`,
      )}`,
      target: "",
    },
    component: () => <RoomsPanel relay={relay} />,
  });
};

export { DoorOpen };
