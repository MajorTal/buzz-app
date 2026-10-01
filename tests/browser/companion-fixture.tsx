// Generic launcher coverage remains independent of bundled Bestie visibility.
import type { BundledPlugin } from "../../src/plugins/manager";

export const companionPlugins: readonly BundledPlugin[] = [
  {
    manifest: {
      id: "fixture.companion",
      name: "Companion fixture",
      apiVersion: 1,
    },
    module: {
      inject: ["panels"],
      apply(ctx) {
        ctx.panels.register({
          id: "companion",
          title: "Companion fixture",
          matches: () => false,
          launcher: { icon: "/bestie.png", target: "fixture-companion" },
          component: () => <p>Companion fixture content</p>,
        });
      },
    },
  },
];
