import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import type {
  AgentControl,
  AgentImportPreview,
  AgentView,
  ImportSource,
  CloneSettings,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";

export function AgentImport({
  ref,
  control,
  disabled,
  initialDestination = "",
  managedAgents,
  commitAvailable = true,
  onImported,
  onClone,
}: {
  ref?: Ref<HTMLElement>;
  control: AgentControl;
  disabled: boolean;
  initialDestination?: string;
  managedAgents: readonly AgentView[];
  commitAvailable?: boolean;
  onClone?: ((settings: CloneSettings) => void) | undefined;
  onImported?: (agents: AgentView[]) => void;
}) {
  const [source, setSource] = useState<ImportSource>("installed");
  const [destination, setDestination] = useState(initialDestination);
  const [previewing, setPreviewing] = useState(false);
  const generation = useRef(0);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<AgentImportPreview | null>(null);
  const [repaired, setRepaired] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invalidatePreview = () => {
    generation.current++;
    setPreview(null);
    setPreviewing(false);
    setError(null);
  };
  const load = useCallback(
    async (from: ImportSource, to: string) => {
      const current = ++generation.current;
      setPreview(null);
      setError(null);
      setPreviewing(true);
      try {
        // A failed Start must not force a separate recovery ritual before browsing.
        // Refresh only reads status; it never retries the failed operation.
        await control.refresh();
        if (generation.current !== current) return;
        const result = await control.previewImport(from, to);
        if (generation.current === current) setPreview(result);
      } catch {
        if (generation.current === current)
          setError(
            "Could not load agents from old Buzz. Check Import options and try again.",
          );
      } finally {
        if (generation.current === current) setPreviewing(false);
      }
    },
    [control],
  );
  useEffect(() => {
    void load("installed", initialDestination);
    return () => {
      generation.current++;
    };
  }, [initialDestination, load]);
  // Native import rejects any key already held locally, in any community.
  const managedKeys = new Set(
    managedAgents.map((agent) => agent.pubkey.toLowerCase()),
  );
  const candidates = preview?.candidates.filter((candidate) => {
    const saved = managedAgents.find((agent) => agent.id === candidate.id);
    // A saved agent reappears only to repair its missing team import.
    return saved
      ? saved.needsTeamImport
      : !managedKeys.has(candidate.pubkey.toLowerCase());
  });
  const commit = async (id: string, repair: boolean, name: string) => {
    if (disabled || importing || !destination.trim() || !preview?.token) return;
    const current = generation.current;
    setImporting(true);
    try {
      const result = await control.commitImport(preview.token, [id]);
      if (generation.current !== current) return;
      if (repair) {
        // The reload supersedes this generation, so release the busy state first.
        setImporting(false);
        setRepaired(name);
        void load(source, destination);
        return;
      }
      onImported?.(result.agents.filter((agent) => agent.id === id));
    } catch (problem) {
      if (generation.current === current) {
        setPreview(null);
        setError(
          problem instanceof Error && problem.message
            ? problem.message
            : "Import didn’t finish. Reload the source before trying again.",
        );
      }
    } finally {
      if (generation.current === current) setImporting(false);
    }
  };
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label="Import from old Buzz"
      className="flex flex-col gap-4 pt-3"
    >
      <p className="m-0 text-body-sm text-secondary">
        Import copies the existing key and settings from the selected
        installation into the chosen community. It leaves the agent stopped.
        Repair team import adds missing team instructions to an existing import
        without replacing its identity or edited settings. Neither action starts
        an agent. Stop the old agent and disable automatic startup there before
        starting it here.
      </p>
      {destination && (
        <p className="m-0 break-all text-body-sm">Community: {destination}</p>
      )}
      {!destination && (
        <p className="m-0 text-body-sm text-secondary">
          These identities are saved on this computer. Choose a destination in
          Import options before importing; browsing does not need a connection.
        </p>
      )}
      {!commitAvailable && (
        <p role="status">Import is unavailable in this app session.</p>
      )}
      {repaired && (
        <p role="status">
          Team instructions imported for {repaired}. Use Start when ready to
          hand over from old Buzz.
        </p>
      )}
      {previewing && <p role="status">Loading agents from old Buzz…</p>}
      {error && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert">{error}</p>
          <Button
            disabled={disabled}
            onClick={() => void load(source, destination)}
          >
            Retry
          </Button>
        </div>
      )}
      {candidates?.length === 0 && (
        <p>
          {destination
            ? "No agents left to import or repair from this library for this community."
            : "No agents in this local library."}
        </p>
      )}
      {candidates?.map((candidate) => {
        const repair = managedAgents.some(
          (agent) => agent.id === candidate.id && agent.needsTeamImport,
        );
        return (
          <div
            key={candidate.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-primary pt-3"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <p className="m-0 font-semibold">{candidate.name}</p>
              <p className="m-0 text-body-sm text-secondary">
                {repair ? "Team instructions not imported" : "Not imported"}
              </p>
              <details className="text-body-sm text-secondary">
                <summary className="cursor-pointer">Identity</summary>
                <p className="break-all font-mono text-mono-sm">
                  {candidate.pubkey}
                </p>
              </details>
            </div>
            {!repair && onClone && control.cloneSettings && (
              <Button
                disabled={disabled || previewing}
                aria-label={`Clone ${candidate.name}`}
                onClick={() => {
                  const current = generation.current;
                  void control
                    .cloneSettings?.(source, candidate.pubkey)
                    .then((settings) => {
                      if (generation.current === current) onClone(settings);
                    })
                    .catch(() => {
                      if (generation.current === current)
                        setError(
                          "Could not read clone settings. Reload the source and try again.",
                        );
                    });
                }}
              >
                Clone to this community
              </Button>
            )}
            <Button
              disabled={
                disabled ||
                previewing ||
                importing ||
                !commitAvailable ||
                !destination.trim() ||
                !preview?.token
              }
              aria-label={`${repair ? "Repair team import for" : "Import"} ${candidate.name}`}
              onClick={() => void commit(candidate.id, repair, candidate.name)}
            >
              {repair ? "Repair team import" : "Import"}
            </Button>
          </div>
        );
      })}
      <details open={!initialDestination || undefined} className="text-body-sm">
        <summary className="cursor-pointer text-secondary">
          Import options
        </summary>
        <fieldset
          disabled={disabled && !previewing}
          className="flex flex-col gap-4 pt-4"
        >
          <Select
            label="Source library"
            variant="field"
            disabled={disabled && !previewing}
            value={source}
            groups={[
              {
                label: "",
                options: [
                  { value: "installed", label: "Installed Buzz" },
                  { value: "development", label: "Development Buzz" },
                ],
              },
            ]}
            onValueChange={(value) => {
              const next = value as ImportSource;
              setSource(next);
              invalidatePreview();
              if (!disabled) void load(next, destination);
            }}
          />
          <Field label="Destination community">
            <Input
              required
              value={destination}
              placeholder="https://community.example"
              spellCheck={false}
              onValueChange={(value) => {
                setDestination(value);
                invalidatePreview();
              }}
            />
          </Field>
          <Button
            disabled={disabled || previewing}
            onClick={() => void load(source, destination)}
          >
            Load agents
          </Button>
        </fieldset>
        {preview && (
          <div className="flex flex-col gap-2 pt-3 text-secondary">
            <p className="break-all">{preview.sourcePath}</p>
            {[...new Set(preview.warnings)].map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        )}
      </details>
    </section>
  );
}
