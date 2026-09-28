import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads the broker's Vite config without native-compatibility warnings", () => {
  // A fresh Node process exercises real config imports, not Vitest's resolver.
  // Loading config creates the plugin but never invokes configureServer, so it
  // cannot read the Keychain, open a server, or contact a relay.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
          import assert from 'node:assert/strict';
          import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
          import { tmpdir } from 'node:os';
          import { join } from 'node:path';
          import { loadConfigFromFile } from 'vite';
          const configFile = join(process.cwd(), 'vite.config.ts');
          // Load the real config with isolated .env files, never personal settings.
          const directory = mkdtempSync(join(tmpdir(), 'buzz-vite-config-'));
          const cwd = process.cwd();
          try {
            process.chdir(directory);
            const loaded = await loadConfigFromFile(
              { command: 'serve', mode: 'development' }, configFile,
            );
            assert(loaded?.config.plugins.some(p => p?.name === 'buzz-relay-broker'));
            assert.equal(loaded.config.define['import.meta.env.VITE_BUZZ_LIVE'], '"1"');
            for (const command of ['serve', 'build']) {
              for (const setting of [undefined, '', '0', '1', 'true', 'invalid']) {
                if (setting === undefined) delete process.env.BUZZ_DEV_NOTIFICATIONS;
                else process.env.BUZZ_DEV_NOTIFICATIONS = setting;
                const result = await loadConfigFromFile(
                  { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
                );
                assert.equal(
                  result.config.define['import.meta.env.VITE_BUZZ_NOTIFICATIONS_PAUSED'],
                  JSON.stringify(command === 'serve' && setting === '0' ? '1' : '0'),
                );
              }
            }
            delete process.env.BUZZ_DEV_NOTIFICATIONS;
            writeFileSync('.env.local', 'BUZZ_DEV_NOTIFICATIONS=0');
            for (const command of ['serve', 'build']) {
              const result = await loadConfigFromFile(
                { command, mode: 'development' }, configFile,
              );
              assert.equal(
                result.config.define['import.meta.env.VITE_BUZZ_NOTIFICATIONS_PAUSED'],
                JSON.stringify(command === 'serve' ? '1' : '0'),
              );
            }
            // BUZZ_DEV_OPEN_RELAY exposes the canonical default relay to a live dev
            // server only when set to exactly "1"; builds and other values see "".
            process.env.BUZZ_RELAY_URL = 'wss://Relay.example.com/';
            for (const command of ['serve', 'build']) {
              for (const setting of [undefined, '', '0', '1', 'true']) {
                if (setting === undefined) delete process.env.BUZZ_DEV_OPEN_RELAY;
                else process.env.BUZZ_DEV_OPEN_RELAY = setting;
                const result = await loadConfigFromFile(
                  { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
                );
                assert.equal(
                  result.config.define['import.meta.env.VITE_BUZZ_OPEN_RELAY'],
                  JSON.stringify(
                    command === 'serve' && setting === '1' ? 'https://relay.example.com' : '',
                  ),
                );
              }
            }
            // OG build alias is presence-only, including empty/false/0. An explicit
            // development setting overrides it. Exercise the real dotenv + Vite boundary.
            delete process.env.BUZZ_DEV_OPEN_RELAY;
            for (const alias of ['', '0', 'false', '1']) {
              writeFileSync('.env.local', 'BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=' + alias);
              for (const command of ['serve', 'build']) {
                for (const override of [undefined, '0', '1']) {
                  if (override === undefined) delete process.env.BUZZ_DEV_OPEN_RELAY;
                  else process.env.BUZZ_DEV_OPEN_RELAY = override;
                  const result = await loadConfigFromFile(
                    { command, mode: command === 'serve' ? 'development' : 'production' }, configFile,
                  );
                  assert.equal(result.config.define['import.meta.env.VITE_BUZZ_OPEN_RELAY'],
                    JSON.stringify(command === 'serve' && override !== '0' ? 'https://relay.example.com' : ''));
                }
              }
            }
            // Without a viewer pin nothing consumes the seed, so it is neither exposed nor required.
            process.env.BUZZ_DEV_OPEN_RELAY = '1';
            process.env.BUZZ_RELAY_URL = '';
            process.env.BUZZ_DEV_VIEWER = '';
            const shell = await loadConfigFromFile(
              { command: 'serve', mode: 'development' }, configFile,
            );
            assert.equal(shell.config.define['import.meta.env.VITE_BUZZ_OPEN_RELAY'], '""');
            // A live server with the flag but no relay URL fails at configuration time.
            process.env.BUZZ_DEV_VIEWER = 'a'.repeat(64);
            await assert.rejects(
              loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile),
              /BUZZ_DEV_OPEN_RELAY=1 requires BUZZ_RELAY_URL/,
            );
          } finally {
            process.chdir(cwd);
            rmSync(directory, { recursive: true, force: true });
          }
        `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        // Keep local Buzz credentials out of the config subprocess.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("BUZZ_"),
          ),
        ),
        BUZZ_DEV_VIEWER: "a".repeat(64),
        BUZZ_RELAY_URL: "",
        BUZZ_COMMUNITY_ALIASES: "",
        VITE_CONFIG_NATIVE_IGNORE_WARNING: "",
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toContain("configLoader: 'native'");
}, 35_000);
