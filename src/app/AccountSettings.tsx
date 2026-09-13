import { useState, useSyncExternalStore } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { Select } from "../shared/design-system/ui/Select";
import type { Identity } from "../features/identity/service";
import {
  identityErrorMessage,
  type LegacyIdentitySource,
} from "../features/identity/contracts";

/** Host UI, never a contributed plugin and never a private-key entry field. */
export function AccountSettings({ identity }: { identity: Identity }) {
  const {
    identity: current,
    pending,
    error,
    selectedPubkey,
    canSignOut,
  } = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [draft, setPubkey] = useState<string | null>(null);
  const pubkey = draft ?? selectedPubkey;
  const [source, setSource] = useState<LegacyIdentitySource>("buzzDesktopBlob");
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const consentKey = `${current?.generation}:${current?.revocation}:${pubkey}:${source}`;
  const consent = consentFor === consentKey;
  const [rejectedSecret, setRejectedSecret] = useState(false);
  const rejectSecret = (value: string) => {
    if (!/nsec1/i.test(value)) return false;
    setPubkey("");
    setConsentFor(null);
    setRejectedSecret(true);
    return true;
  };
  const unsupported = (error ?? current?.reason) === "unsupportedPlatform";
  const failure = rejectedSecret ? "invalidInput" : (error ?? current?.reason);
  return (
    <section
      data-buzz-ui=""
      aria-labelledby="account-settings-title"
      className="text-body text-primary"
    >
      <h2 id="account-settings-title" className="mt-0 mb-3 text-heading-sm">
        Account
      </h2>
      <div className="grid gap-4">
        <p className="mt-0 text-body-sm text-secondary">
          Use your existing Buzz identity. This step is local only: it does not
          join a community, publish a profile, or create a new identity.
        </p>
        <p className="text-body-sm text-secondary">
          This page manages local identity only. Mobile pairing and independent
          private-key entry are not part of this setup.
        </p>
        <p role="status">
          {pending === "status"
            ? "Checking local identity status…"
            : pending === "signOut"
              ? "Signing out…"
              : pending
                ? "Waiting for secure credential access…"
                : current?.busy
                  ? "Secure credential work is still in progress. Check status when it finishes."
                  : current?.state === "ready"
                    ? "Identity unlocked on this host."
                    : current?.state === "signedOut"
                      ? "Signed out."
                      : "Identity access is unavailable or could not be confirmed."}
        </p>
        {current?.pubkey && (
          <p className="break-all">
            <span className="text-body-sm text-secondary">Public key: </span>
            <code>{current?.pubkey}</code>
          </p>
        )}
        {failure && (
          <p role="alert" className="text-body text-primary">
            {identityErrorMessage[failure]}
          </p>
        )}
        {current?.state === "signedOut" && !current.busy && !pending && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void identity.unlockSaved(pubkey);
            }}
          >
            <label className="grid gap-2 text-body-sm">
              Existing public key
              <input
                value={pubkey}
                onChange={(event) => {
                  const value = event.target.value;
                  if (rejectSecret(value)) {
                    event.target.value = "";
                    return;
                  }
                  setPubkey(value);
                  setRejectedSecret(false);
                  setConsentFor(null);
                }}
                onPaste={(event) => {
                  // Stop recognizable secrets before the browser inserts them into the DOM.
                  if (rejectSecret(event.clipboardData.getData("text")))
                    event.preventDefault();
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="npub1… or 64-character public hex"
                maxLength={128}
                onDrop={(event) => {
                  if (rejectSecret(event.dataTransfer.getData("text")))
                    event.preventDefault();
                }}
                className="rounded border border-primary bg-transparent p-2 text-body text-primary"
                aria-describedby="identity-public-key-help"
              />
            </label>
            <p
              id="identity-public-key-help"
              className="text-body-sm text-secondary"
            >
              Copy the public key from your existing Buzz account. Never paste
              an nsec/private key. This public selection is remembered locally;
              it does not unlock anything by itself.
            </p>
            <Button type="submit" disabled={!pubkey.trim()}>
              Unlock saved identity
            </Button>
            <h3 className="mt-6 text-heading-sm">Copy from existing Buzz</h3>
            <Select
              label="Credential source (macOS)"
              value={source}
              groups={[
                {
                  label: "Buzz Desktop",
                  options: [
                    {
                      value: "buzzDesktopBlob",
                      label: "Secrets entry (current dev-broker source)",
                    },
                    {
                      value: "buzzDesktopPerKey",
                      label: "Identity entry (older per-key source)",
                    },
                  ],
                },
              ]}
              onValueChange={(value) => {
                if (
                  value !== "buzzDesktopBlob" &&
                  value !== "buzzDesktopPerKey"
                )
                  return;
                setSource(value);
                setConsentFor(null);
              }}
            />
            <p className="text-body-sm text-secondary">
              Only the selected source is read; no fallback or legacy migration
              runs. The same identity is copied into this app's own secure
              storage. Old Buzz stays unchanged, but later rotation or deletion
              there will not update this independent copy.
            </p>
            <label className="my-4 flex items-start gap-3 text-body-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={consent}
                onChange={(event) =>
                  setConsentFor(event.target.checked ? consentKey : null)
                }
              />
              I authorize copying the identity matching this public key from the
              selected source.
            </label>
            <Button
              type="button"
              disabled={!consent || !pubkey.trim()}
              onClick={() => {
                setConsentFor(null);
                void identity.importLegacy(pubkey, source, consent);
              }}
            >
              Copy my existing Buzz identity
            </Button>
          </form>
        )}
        {!unsupported && (
          <div className="mt-6 flex flex-wrap gap-3">
            {!pending && (
              <Button
                type="button"
                onClick={() => {
                  void identity.refresh();
                }}
              >
                Check identity status
              </Button>
            )}
            {canSignOut && (
              <Button
                type="button"
                disabled={pending === "signOut"}
                onClick={() => {
                  setConsentFor(null);
                  void identity.signOut();
                }}
              >
                Sign out
              </Button>
            )}
          </div>
        )}
        {!unsupported && !canSignOut && (
          <p className="text-body-sm text-secondary">
            Sign-out needs a reply from the native identity service first. If
            status remains unavailable, quit the app to revoke this process’s
            identity.
          </p>
        )}
        <p className="mb-0 mt-4 text-body-sm text-secondary">
          Sign-out locks this app, keeps its saved copy, and never deletes the
          old Buzz credential. If a copy was already being saved when cancelled,
          it may remain in secure storage but cannot activate from that
          cancelled operation. Reloading this window keeps the native identity;
          quitting the app locks it. A timeout does not cancel an OS prompt.
        </p>
      </div>
    </section>
  );
}
