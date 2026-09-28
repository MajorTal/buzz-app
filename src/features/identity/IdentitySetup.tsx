import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import type { Identity } from "./service";

export function IdentitySetup({
  identity,
  children,
}: {
  identity: Identity;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const [importing, setImporting] = useState(false);
  const [nsec, setNsec] = useState("");
  if (state.status === "ready") return children;
  return (
    <main className="p-8" aria-labelledby="identity-setup-title">
      <h1 id="identity-setup-title" className="text-heading">
        Your Buzz identity
      </h1>
      {state.status === "loading" ? (
        <p role="status">Opening your saved identity…</p>
      ) : state.status === "error" ? (
        <>
          <p role="alert">{state.error}</p>
          <Button onClick={() => void identity.retry()}>
            Retry secure storage access
          </Button>
        </>
      ) : (
        <>
          <p>
            Already use Buzz? Bring your existing private key to keep the same
            identity.
          </p>
          <p>
            Your key is stored securely on this device. No community is joined
            automatically.
          </p>
          {state.error && <p role="alert">{state.error}</p>}
          {importing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const supplied = nsec;
                setNsec("");
                void identity.importKey(supplied);
              }}
            >
              <label htmlFor="import-nsec">Private key (nsec)</label>
              <Input
                id="import-nsec"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={nsec}
                disabled={state.busy}
                onChange={(event) => setNsec(event.target.value)}
              />
              <p>
                Copy this from Identity details in your old Buzz app. Never
                share it with anyone.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={state.busy || !nsec.trim()}
                >
                  Use this key
                </Button>
                <Button
                  type="button"
                  disabled={state.busy}
                  onClick={() => {
                    setNsec("");
                    setImporting(false);
                  }}
                >
                  Back
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={state.busy}
                variant="primary"
                onClick={() => setImporting(true)}
              >
                Use an existing key
              </Button>
              <Button
                disabled={state.busy}
                onClick={() => void identity.create()}
              >
                Create a new identity
              </Button>
            </div>
          )}
          {state.busy && <p role="status">Saving your identity securely…</p>}
        </>
      )}
    </main>
  );
}
