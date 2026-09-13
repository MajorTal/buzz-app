import { fixtureAliases } from "../relay-config.ts";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Playwright owns this worker-scoped build. Only compiled assets are shared;
// each test still owns its server, identities, relay state and browser storage.
export async function buildApp(
  { developmentReact, pluginFixtures, withoutPresence },
  use,
) {
  const directory = await mkdtemp(join(tmpdir(), "buzz-browser-build-"));
  try {
    const config = {
      root,
      configFile: false,
      envFile: false, // Never read the developer's live identity configuration.
      logLevel: "error",
      plugins: [
        react(),
        ...(withoutPresence
          ? [
              {
                name: "fixture-no-presence-control",
                transform(code, id) {
                  if (id !== join(root, "src/features/relay/session.ts"))
                    return;
                  // Equivalent app, connection and read paths. Disable both optional
                  // owners through their shared support decision, not admission substitutes.
                  const support =
                    "transport?.presence === true && !!transport.subscribe";
                  if (code.split(support).length !== 2)
                    throw new Error(
                      `Missing presence control seam: ${support}`,
                    );
                  return code.replace(support, "false");
                },
              },
            ]
          : []),
        ...(pluginFixtures
          ? [
              {
                name: "fixture-installed-plugins",
                transform(code, id) {
                  if (id !== join(root, "src/bundled/index.ts")) return;
                  return `import { fixturePlugins } from ${JSON.stringify(join(root, "tests/browser/plugin-fixtures.tsx"))};\n${code.replace("= [", "= [ ...fixturePlugins,")}`;
                },
              },
            ]
          : []),
      ],
      define: {
        "import.meta.env.VITE_BUZZ_LIVE": '"1"',
        "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES":
          JSON.stringify(fixtureAliases),
        ...(developmentReact
          ? { "process.env.NODE_ENV": '"development"' }
          : {}),
      },
      build: { outDir: join(directory, "dist"), emptyOutDir: true },
    };
    const start = performance.now();
    await build(config);
    await use({ config, durationMs: performance.now() - start });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
