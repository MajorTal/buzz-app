import { avatarSource } from "../src/shared/avatar-source.ts";
// Read-only compatibility with old Buzz's post-fold managed-agents.json.
// Never call its loaders: load_managed_agents hydrates/migrates keys and
// load_personas can merge builtins and write back. Project display fields only.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 2000;
const HEX = /^[0-9a-f]{64}$/;
const failure = () =>
  new Error(
    "Could not read the current Buzz agent library. Open Buzz and retry; its saved library is left unchanged.",
  );
function text(value, max = 256) {
  if (typeof value !== "string" || value.length > max) throw failure();
  return value;
}
export function projectAgentLibrary(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw failure();
  const definitions = [],
    identities = [];
  const slugs = new Set(),
    keys = new Set();
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw failure();
    const pubkey = text(row.pubkey, 64);
    const name = text(row.name);
    const avatar = avatarSource(row.avatar_url);
    const artwork = avatar ? { avatar } : {};
    if (!pubkey) {
      // Old to_definition_view skips keyless records without a slug.
      if (row.slug == null) continue;
      const id = text(row.slug);
      if (!id || slugs.has(id)) throw failure();
      slugs.add(id);
      if (row.is_active !== undefined && typeof row.is_active !== "boolean")
        throw failure();
      if (row.is_active === false) continue;
      definitions.push({
        id,
        ...artwork,
        name: row.display_name == null ? name : text(row.display_name),
      });
    } else {
      if (!HEX.test(pubkey) || keys.has(pubkey)) throw failure();
      keys.add(pubkey);
      const definitionId =
        row.persona_id == null ? undefined : text(row.persona_id);
      identities.push({
        pubkey,
        ...artwork,
        name,
        ...(definitionId ? { definitionId } : {}),
      });
    }
  }
  return { definitions, identities };
}
/** Installed Buzz desktop's app-data directory: Tauri's per-platform location for its identifier. */
export function installedBuzzDataDir(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (platform === "darwin")
    return join(home, "Library/Application Support/xyz.block.buzz.app");
  if (platform === "linux")
    return join(
      env.XDG_DATA_HOME || join(home, ".local/share"),
      "xyz.block.buzz.app",
    );
  if (platform === "win32" && env.APPDATA)
    return join(env.APPDATA, "xyz.block.buzz.app");
  return undefined;
}
export async function readAgentLibrary(
  path = (() => {
    const dir = installedBuzzDataDir();
    return dir ? join(dir, "agents/managed-agents.json") : undefined;
  })(),
) {
  if (!path) throw failure();
  let file;
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw failure();
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw failure();
    // No raw contents or parser errors escape this host-only function.
    return projectAgentLibrary(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, size),
        ),
      ),
    );
  } catch {
    throw failure();
  } finally {
    buffer.fill(0);
    await file?.close();
  }
}
