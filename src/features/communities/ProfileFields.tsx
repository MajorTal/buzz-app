import type { PersonalProfile } from "./service";

export function canSaveProfile(profile: PersonalProfile) {
  return (
    !!profile.name.trim() &&
    (!profile.picture || profile.picture.startsWith("https://"))
  );
}

export function ProfileFields({
  profile,
  onChange,
  disabled = false,
}: {
  profile: PersonalProfile;
  onChange(profile: PersonalProfile): void;
  disabled?: boolean;
}) {
  return (
    <>
      <label className="mt-5 block text-label-sm">
        Display name
        <input
          className="mt-2 block w-full rounded-xl border border-input-line bg-surface px-3 py-2.5 font-normal"
          autoComplete="nickname"
          required
          disabled={disabled}
          value={profile.name}
          maxLength={100}
          onChange={(event) =>
            onChange({ ...profile, name: event.target.value })
          }
        />
      </label>
      <label className="mt-5 block text-label-sm">
        Picture URL <span className="font-normal text-muted">(optional)</span>
        <input
          className="mt-2 block w-full rounded-xl border border-input-line bg-surface px-3 py-2.5 font-normal"
          type="url"
          placeholder="https://…"
          disabled={disabled}
          value={profile.picture}
          maxLength={2048}
          onChange={(event) =>
            onChange({ ...profile, picture: event.target.value })
          }
        />
      </label>
    </>
  );
}
