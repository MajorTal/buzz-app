import { test, expect } from "./fixture.mjs";

const accountTarget = { version: 1, kind: "settings", section: "account" };

// Synthetic invoke endpoint only. The app/controller/router/UI remain production.
// NOT native IPC/fallback or Keychain validation; no OS credentials are touched.
async function nativeFixture(page, loading = false) {
  await page.addInitScript(
    ({ loading }) => {
      const storage = "identity-account-native-fixture";
      const initial = {
        state: "signedOut",
        pubkey: null,
        generation: "0",
        revocation: "00000000-0000-4000-8000-000000000001",
        busy: false,
        reason: null,
      };
      let status =
        JSON.parse(sessionStorage.getItem(storage) ?? "null") ?? initial;
      window.identityFixtureCalls = [];
      window.__TAURI_INTERNALS__ = {
        invoke: async (command, args) => {
          window.identityFixtureCalls.push({ command, args });
          if (command === "plugin_catalog") {
            if (loading) return new Promise(() => {});
            return {
              status: "recovery",
              reason: "Synthetic plugin recovery",
              canReset: true,
            };
          }
          if (command === "identity_status") return { ...status };
          const request = args?.request;
          if (request?.revocation !== status.revocation)
            throw { code: "cancelled" };
          if (command === "identity_unlock_saved") {
            status = {
              ...status,
              state: "ready",
              pubkey: request.expectedPubkey,
              generation: String(BigInt(status.generation) + 2n),
            };
          } else if (command === "identity_sign_out") {
            status = {
              ...status,
              state: "signedOut",
              pubkey: null,
              generation: String(BigInt(status.generation) + 1n),
              revocation: "00000000-0000-4000-8000-000000000002",
            };
          } else throw new Error(`Unexpected fixture command: ${command}`);
          sessionStorage.setItem(storage, JSON.stringify(status));
          return { ...status };
        },
      };
      window.isTauri = true;
    },
    { loading },
  );
}

test("Account remains reachable during plugin recovery, reconnects on reload and does not call broker", async ({
  page,
  app,
}) => {
  await nativeFixture(page);
  const brokerRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/relay/"))
      brokerRequests.push(request.url());
  });
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify(accountTarget))}`,
  );
  const account = page.getByRole("region", { name: "Account", exact: true });
  await expect(account).toBeVisible();
  await expect(page.getByText("Signed out.", { exact: true })).toBeVisible();
  const pin =
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  await account.getByRole("textbox", { name: "Existing public key" }).fill(pin);
  await account.getByRole("button", { name: "Unlock saved identity" }).click();
  await expect(
    account.getByText("Identity unlocked on this host."),
  ).toBeVisible();
  await page.reload();
  await expect(
    account.getByText("Identity unlocked on this host."),
  ).toBeVisible();
  expect(brokerRequests).toEqual([]);
  const calls = await page.evaluate(() => window.identityFixtureCalls);
  expect(calls.map((call) => call.command)).toEqual(
    expect.arrayContaining(["identity_status", "plugin_catalog"]),
  );
  expect(
    calls.some((call) => /identity_(sign_out|unlock_saved)/.test(call.command)),
  ).toBe(false);
  await account.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(account.getByText("Signed out.", { exact: true })).toBeVisible();
  await expect(
    account.getByRole("textbox", { name: "Existing public key" }),
  ).toHaveValue(pin);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(account).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  }
});

test("failed navigation can reach Account even while plugin startup never replies", async ({
  page,
  app,
}) => {
  await nativeFixture(page, true);
  const invalid = { version: 1, kind: "settings", section: "missing-section" };
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify(invalid))}`,
  );
  await expect(
    page.getByRole("heading", { name: "This destination couldn’t open" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Manage account", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Account", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Signed out.", { exact: true })).toBeVisible();
  expect(
    decodeURIComponent(await page.evaluate(() => location.hash)),
  ).toContain('"section":"account"');
});
