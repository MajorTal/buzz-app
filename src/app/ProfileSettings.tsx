import { Button } from "../shared/design-system/ui/Button";
import { useState, useSyncExternalStore } from "react";
import type {
  Communities,
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
  const [draft, setDraft] = useState<PersonalProfile | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const profile = draft ?? client.profile;
  return (
    <section aria-labelledby="profile-settings-title">
      <h2 id="profile-settings-title" className="mt-0 mb-6 text-label">
        Profile
      </h2>
      <div>
        <p className="mt-0 text-body-sm text-muted">
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
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSaveProfile(profile)) return;
              setError("");
              try {
                communities.saveProfile({
                  ...profile,
                  name: profile.name.trim(),
                });
                setDraft(null);
                setSaved(true);
              } catch (reason) {
                setSaved(false);
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
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
              <Button
                type="submit"
                disabled={!canSaveProfile(profile)}
                variant="primary"
              >
                Save profile
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setSaved(false);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <p role="status" className="m-0 text-body-sm text-muted">
                {saved ? "Profile updated." : ""}
              </p>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
