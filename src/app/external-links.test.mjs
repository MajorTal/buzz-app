import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

it("registers the desktop link fallback in the production native builder", () => {
  // Browser popups alone cannot catch the original desktop-only regression.
  // Keep this guard on the actual registration, not a test-installed opener.
  expect(read("../../src-tauri/src/lib.rs")).toMatch(
    /\.plugin\(tauri_plugin_opener::init\(\)\)/,
  );
  expect(read("../../src-tauri/Cargo.toml")).toMatch(
    /^tauri-plugin-opener = "2"$/m,
  );
});

it("grants only HTTP(S) opening to app windows, without file or application access", () => {
  const capability = JSON.parse(
    read("../../src-tauri/capabilities/default.json"),
  );
  // Detached tab windows render the same pages and need the same link fallback.
  expect(capability.windows).toEqual(["main", "tabs-*"]);
  expect(capability.remote).toBeUndefined();
  const openerPermissions = capability.permissions.filter((permission) =>
    (typeof permission === "string"
      ? permission
      : permission.identifier
    ).startsWith("opener:"),
  );
  expect(openerPermissions).toEqual([
    {
      identifier: "opener:allow-open-url",
      allow: [{ url: "https://*" }, { url: "http://*" }],
    },
  ]);
});
