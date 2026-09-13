import { useState, useSyncExternalStore } from "react";
import type {
  Communities,
  ClientSnapshot,
  PersonalProfile,
} from "../features/communities/service";
import {
  canSaveProfile,
  ProfileFields,
} from "../features/communities/ProfileFields";

export function ProfileSettings({ communities }: { communities: Communities }) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  return (
    <section aria-labelledby="profile-settings-title">
      <h2 id="profile-settings-title" className="mt-0 mb-3 text-lg font-medium">
        Profile
      </h2>
      <div className="rounded-3xl border border-shell-edge/80 bg-surface p-5 shadow-surface sm:p-6">
        <p className="mt-0 text-sm text-muted">
          Your local default for new communities. Saving here does not change
          your existing community profiles.
        </p>
        {client.status !== "ready" ? (
          <p role="status">
            {client.status === "loading"
              ? "Opening your local identity…"
              : "Your local identity is unavailable. Connect your identity to edit your profile."}
          </p>
        ) : (
          <ProfileDraft
            key={client.epoch}
            communities={communities}
            client={client}
          />
        )}
      </div>
    </section>
  );
}

// A hidden Settings tab keeps this draft; replacing its account does not.
function ProfileDraft({
  communities,
  client,
}: {
  communities: Communities;
  client: ClientSnapshot;
}) {
  const [account] = useState(() => communities.capture());
  const [draft, setDraft] = useState<PersonalProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const profile = draft ?? client.profile;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSaveProfile(profile)) return;
        setError("");
        try {
          communities.saveProfile(
            { ...profile, name: profile.name.trim() },
            account,
          );
          communities.assertCurrent(account);
          setDraft(null);
          setSaved(true);
        } catch (reason) {
          setSaved(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }}
    >
      <ProfileFields
        profile={profile}
        onChange={(next) => {
          setDraft(next);
          setSaved(false);
          setError("");
        }}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!canSaveProfile(profile)}
          className="border-ink bg-primary text-on-primary hover:bg-primary-hover"
        >
          Save profile
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(null);
            setSaved(false);
            setError("");
          }}
        >
          Cancel
        </button>
        <p role="status" className="m-0 text-sm text-muted">
          {saved ? "Profile updated." : ""}
        </p>
      </div>
    </form>
  );
}
