// FOUNDATION: Compose the bundled distribution, plugin runtime, and services here.
import { provideNavigation } from "../features/navigation/service";
import { NotificationsService } from "../features/notifications/service";
import {
  bindMessageNotifications,
  notificationAuthorized,
} from "../features/notifications/messages";
import { ShortcutsService } from "../features/shortcuts/service";
import { ConversationService } from "../features/conversation/service";
import { createAppearance } from "../shared/theme/service";
import { createCommunities } from "../features/communities/service";
import { PanelsService } from "../features/panels/service";
import { Context } from "@deepseek-ai/cordis";
import { PagesService } from "../features/pages/service";
import { bundledPlugins } from "../bundled";
import { createPluginManager } from "../plugins/manager";
import { withTimeout } from "../plugins/timeout";

export function createServices() {
  const appearance = createAppearance();
  const ctx = new Context();
  const plugins = createPluginManager(ctx, {
    bundled: bundledPlugins,
  });
  const navigationHost = provideNavigation(ctx);
  const navigation = navigationHost.navigation;
  const shortcuts = new ShortcutsService(ctx);
  const pages = new PagesService(ctx);
  const panels = new PanelsService(ctx);
  const conversation = new ConversationService(ctx);
  const communities = createCommunities(
    ctx,
    import.meta.env.VITE_BUZZ_LIVE === "1",
  );
  const relay = communities.relay;
  const notifications = new NotificationsService(
    ctx,
    navigation,
    undefined,
    undefined,
    (target) => notificationAuthorized(communities, target),
  );
  ctx.effect(() => bindMessageNotifications(notifications, communities));
  let disposal: Promise<void> | undefined;
  return {
    notifications,
    navigation,
    navigationHost,
    shortcuts,
    conversation,
    pages,
    panels,
    plugins,
    relay,
    communities,
    appearance,
    dispose() {
      appearance.dispose();
      // Start root cancellation without waiting for plugin-owned cleanup. Cordis
      // starts sibling effects independently; the runtime still owns replacement
      // barriers. A timeout reports incomplete cleanup, never successful disposal.
      disposal ??= withTimeout(
        Promise.all([plugins.dispose(), ctx.fiber.dispose()]),
        "App cleanup timed out; restart the app",
      ).then(() => {});
      return disposal;
    },
  };
}

export type AppServices = ReturnType<typeof createServices>;
