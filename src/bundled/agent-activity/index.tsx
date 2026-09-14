import type { PluginModule } from "../../plugins/api";
import type { RelaySession } from "../../features/relay/session";
import { activitySelection } from "../../features/agents/activity-target";
import { ActivityPanel } from "./ActivityPanel";
export const inject = ["panels", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.effect(() => {
    let session: RelaySession | undefined;
    let release: (() => void) | undefined;
    const bind = () => {
      const connection = relay.snapshot();
      const next =
        connection.status === "ready" ? connection.session : undefined;
      if (next === session) return;
      release?.();
      session = next;
      release = next?.agentActivity.activate();
    };
    const stop = relay.subscribe(bind);
    bind();
    return () => {
      stop();
      release?.();
    };
  });
  ctx.panels.register({
    id: "activity",
    title: "Agent Activity",
    matches: (target) => !!activitySelection(target),
    launcher: { icon: "/agent-activity.svg", target: "" },
    component: ({ target }) => <ActivityPanel relay={relay} target={target} />,
  });
};
