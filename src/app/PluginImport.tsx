import { Button } from "../shared/design-system/ui/Button";
import { useEffect, useRef, useState } from "react";
import {
  IconFolderOpen as FolderOpen,
  IconGitBranch as GitBranch,
} from "@tabler/icons-react";
import type { PluginManager } from "../plugins/manager";
import type { Catalog, ImportPreview } from "../plugins/types";

export function PluginImport({
  plugins,
  catalog,
  busy,
}: {
  plugins: PluginManager;
  catalog: Catalog;
  busy: boolean;
}) {
  const imports = plugins.imports;
  const [gitForm, setGitForm] = useState(false);
  const [repository, setRepository] = useState("");
  const [reference, setReference] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lifetime = useRef({ active: true, token: "" });
  const pending = useRef(false);
  useEffect(() => {
    const current = { active: true, token: "" };
    lifetime.current = current;
    return () => {
      current.active = false;
      if (current.token) void imports?.discard(current.token).catch(() => {});
    };
  }, [imports]);

  if (!imports)
    return (
      <p className="mb-4 text-body-sm text-muted">
        Open the desktop app to load plugins from a folder or Git repository.
      </p>
    );

  async function load(operation: () => Promise<ImportPreview | null>) {
    if (pending.current || busy) return;
    pending.current = true;
    const current = lifetime.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const next = await operation();
      if (!current.active) {
        if (next) await imports?.discard(next.token);
        return;
      }
      current.token = next?.token ?? "";
      setPreview(next);
      setSelected(
        next?.candidates.length === 1 ? (next.candidates[0]?.path ?? "") : "",
      );
    } catch (reason) {
      if (current.active) setError(String(reason));
    } finally {
      pending.current = false;
      if (current.active) setLoading(false);
    }
  }
  async function dismiss() {
    if (busy || loading || !preview) return;
    try {
      await imports?.discard(preview.token);
      lifetime.current.token = "";
      setPreview(null);
    } catch (reason) {
      setError(String(reason));
    }
  }
  const candidate = preview?.candidates.find((p) => p.path === selected);
  const existing = catalog.plugins.find(
    (p) => p.manifest.id === candidate?.manifest.id,
  );
  return (
    <div className="mb-4">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={busy || loading}
          onClick={() => void load(imports.folder)}
        >
          <FolderOpen aria-hidden="true" size={17} /> Load from folder
        </Button>
        <Button
          type="button"
          disabled={busy || loading}
          aria-expanded={gitForm}
          onClick={() => setGitForm(!gitForm)}
        >
          <GitBranch aria-hidden="true" size={17} /> Load from Git
        </Button>
      </div>
      {gitForm && (
        <form
          className="mt-3 grid gap-3 rounded-2xl border border-line bg-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (repository.trim())
              void load(() => imports.git(repository, reference));
          }}
        >
          <label className="grid gap-1 text-body-sm">
            Git or GitHub repository
            <input
              required
              value={repository}
              disabled={loading}
              placeholder="https://github.com/owner/repository"
              onChange={(event) => setRepository(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-body-sm">
            Branch or tag (optional)
            <input
              value={reference}
              disabled={loading}
              placeholder="Repository default"
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
          <p className="m-0 text-caption text-muted">
            HTTPS or SSH; GitHub owner/repository also works. SSH uses your
            agent and known hosts. Password prompts and credential helpers are
            not used.
          </p>
          <div className="justify-self-start">
            <Button
              type="submit"
              disabled={busy || loading || !repository.trim()}
            >
              Find plugins
            </Button>
          </div>
        </form>
      )}
      <p className="mb-0 text-caption text-muted">
        Choose built plugins with manifest.json and plugin.js. Buzz does not
        build source projects or run install scripts. Only load code you trust:
        plugins are not sandboxed.
      </p>
      {loading && (
        <p role="status">
          Reading plugin folders… Git imports may take up to a minute.
        </p>
      )}
      {error && (
        <p role="alert" className="error break-words">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {preview && (
        <section
          aria-label="Plugin import preview"
          className="mt-4 grid gap-3 rounded-2xl border border-line bg-surface p-4"
        >
          <div className="min-w-0 text-body-sm">
            <p className="m-0 break-all font-medium">{preview.source}</p>
            {preview.commit && (
              <p className="m-0 break-all text-caption text-muted">
                Commit: {preview.commit}
              </p>
            )}
          </div>
          {preview.candidates.length === 0 ? (
            <p className="m-0">
              No built plugins found. Build the plugin first, then choose its
              output folder, or use a repository that includes built artifacts.
            </p>
          ) : (
            <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
              <legend className="mb-2 text-label-sm">
                Choose a plugin folder
              </legend>
              {preview.candidates.map((item) => (
                <label
                  key={item.path}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-checked:bg-soft"
                >
                  <input
                    type="radio"
                    name="plugin-folder"
                    className="mt-1"
                    value={item.path}
                    checked={selected === item.path}
                    disabled={busy}
                    onChange={() => {
                      setSelected(item.path);
                      setNotice(null);
                    }}
                  />
                  <span className="min-w-0 text-body-sm">
                    <span className="block font-medium">
                      {item.manifest.name}
                    </span>
                    <span className="block break-all text-muted">
                      {item.path} · {item.manifest.id}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {preview.warnings.length > 0 && (
            <details className="text-body-sm text-muted">
              <summary>Folders skipped ({preview.warnings.length})</summary>
              <ul className="break-words">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {candidate && (
            <p className="m-0 text-body-sm">
              {existing
                ? `This replaces ${existing.manifest.name} (${existing.manifest.id}). ${existing.enabled ? "It stays enabled and may run immediately unless this launch is in safe mode." : "It stays disabled."} Roll back remains available.`
                : "This plugin will be installed disabled. Enable it in the list when you’re ready."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {candidate && (
              <Button
                type="button"
                disabled={busy || loading}
                onClick={async () => {
                  const current = lifetime.current;
                  const success = await plugins.installImport(
                    preview.token,
                    candidate.path,
                  );
                  if (success && current.active)
                    setNotice(
                      `${candidate.manifest.name} installed. You can choose another folder or close this preview.`,
                    );
                }}
              >
                {existing ? "Update plugin" : "Install plugin"}
              </Button>
            )}
            <Button
              type="button"
              disabled={busy || loading}
              onClick={() => void dismiss()}
            >
              Close preview
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
