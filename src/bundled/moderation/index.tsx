import type { PluginModule } from "../../plugins/api";
import { CommunityAdmin } from "./CommunityAdmin";
import { canManageMembership, createCommunityMembership } from "./membership";

export const inject = ["relay", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const membership = createCommunityMembership(relay);
  ctx.effect(() => () => membership.dispose());
  // Registered in every build. Native builds cannot mint invites or change
  // members, but the card still shows owners and admins the relay-signed
  // member list and hides those controls itself, so a Settings section,
  // history entry or in-app locator naming it opens instead of failing.
  ctx.settingsCards.register({
    id: "membership",
    title: "Membership",
    section: "administration",
    visibility: {
      snapshot: () => {
        const connection = relay.snapshot();
        const state = membership.snapshot();
        if (canManageMembership(state)) return true;
        if (
          connection.status === "error" ||
          connection.status === "disconnected" ||
          state.error
        )
          return "error";
        if (
          state.status === "idle" ||
          state.status === "loading" ||
          state.refreshing
        )
          return "pending";
        return false;
      },
      subscribe: membership.subscribe,
      ensure: membership.ensure,
    },
    component: ({ active, community }) => (
      <CommunityAdmin
        relay={relay}
        membership={membership}
        {...(community ? { communityName: community.name } : {})}
        active={active}
      />
    ),
  });
};
