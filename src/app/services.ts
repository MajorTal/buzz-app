// FOUNDATION: Compose the bundled distribution, plugin runtime, and services here.
import { provideNavigation } from "../features/navigation/service";
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
import { createIdentity } from "../features/identity/service";
import { createNativeIdentityBackend } from "../features/identity/native";
import { createNativeCommunities } from "../features/communities/native";

export function createServices() {
  // One renderer owner reconnects to process identity; Account mounts own no session.
  const nativeIdentity = createNativeIdentityBackend();
  const identity = createIdentity(nativeIdentity);
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
    // Never use a broker's potentially different key as native identity transport.
    // Native advertises finite reads + kind-0/9 writes, not broker/live parity.
    !nativeIdentity && import.meta.env.VITE_BUZZ_LIVE === "1",
    nativeIdentity ? createNativeCommunities(identity) : undefined,
  );
  const relay = communities.relay;
  let disposal: Promise<void> | undefined;
  return {
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
    identity,
    dispose() {
      identity.dispose(); // Renderer cleanup only. Native sign-out is an explicit action.
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
