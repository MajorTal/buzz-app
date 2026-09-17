import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Button } from "../../shared/design-system/ui/Button";
import {
  communityRequest,
  inspectProfile,
  publishProfile,
  type CommunityInfo,
} from "./api";
import type { Communities, PersonalProfile } from "./service";
import { canSaveProfile, ProfileFields } from "./ProfileFields";
import { communityDestination, relayOrigin } from "./destination";
import { registerBrokerCommunity } from "../relay/transport";
import styles from "./Communities.module.css";

export function CommunityDialog({
  communities,
  mode,
  close,
  onJoined,
}: {
  communities: Communities;
  mode: "join" | "profile";
  close(): void;
  onJoined?: (id: string) => void;
}) {
  const client = communities.snapshot();
  const [url, setUrl] = useState("");
  const [destination, setDestination] =
    useState<ReturnType<typeof communityDestination>>();
  const id = destination?.id ?? "";
  const [step, setStep] = useState<"destination" | "access" | "profile">(
    mode === "profile" ? "profile" : "destination",
  );
  const [info, setInfo] = useState<CommunityInfo>();
  const [profile, setProfile] = useState<PersonalProfile>(client.profile);
  const [original, setOriginal] =
    useState<Awaited<ReturnType<typeof inspectProfile>>>();
  const [code, setCode] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const policy = info?.policy;
  const allowed =
    (!policy?.age_attestation_required || adult) &&
    (!(policy?.terms_markdown || policy?.privacy_markdown) || agreed);
  async function submit() {
    if (step === "destination") {
      await work(async () => {
        const next = communityDestination(relayOrigin(url));
        setDestination(next);
        await registerBrokerCommunity(next.id, AbortSignal.timeout(12000));
        const value = await communityRequest<CommunityInfo>(next.id, "info");
        // Restoring an existing admitted profile is not a new join or policy acceptance.
        const found = await inspectProfile(next.id).catch(() => undefined);
        if (mounted.current) {
          setInfo(value);
          if (found?.exists) {
            setOriginal(found);
            setProfile(found.profile);
            setStep("profile");
          } else setStep("access");
        }
      });
    } else if (step === "access") {
      if (!allowed) return;
      await work(async () => {
        if (code.trim()) {
          let receipt: string | undefined;
          if (policy)
            receipt = (
              await communityRequest<{ receipt: string }>(id, "accept-policy", {
                code: code.trim(),
                policy_version: policy.version,
                age_confirmed: adult,
              })
            ).receipt;
          const claim = await communityRequest<{ status: string }>(
            id,
            "claim",
            { code: code.trim(), policy_receipt: receipt },
          );
          if (!["joined", "already_member"].includes(claim.status))
            throw new Error("Membership was not confirmed");
        }
        const found = await inspectProfile(id);
        if (!mounted.current) return;
        setOriginal(found);
        setProfile(found.exists ? found.profile : client.profile);
        setStep("profile");
      });
    } else {
      if (!profile.name.trim()) return;
      await work(async () => {
        if (mode === "profile")
          communities.saveProfile({ ...profile, name: profile.name.trim() });
        else {
          if (!destination) throw new Error("Choose a community first");
          if (
            !original?.exists ||
            profile.name !== original.profile.name ||
            profile.picture !== original.profile.picture
          )
            await publishProfile(id, profile, original?.existing ?? {});
          communities.joined(
            {
              id,
              name:
                info?.name && info.name !== "Buzz Relay"
                  ? info.name
                  : destination.name,
              ...(info?.icon?.startsWith("https://")
                ? { icon: info.icon }
                : {}),
            },
            profile,
          );
          onJoined?.(id);
        }
        close();
      });
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      preventClose={busy}
      title={
        mode === "profile"
          ? "Your profile"
          : step === "profile"
            ? `Your profile in ${info?.name && info.name !== "Buzz Relay" ? info.name : destination?.name}`
            : "Add a community"
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === "join" && step !== "destination" && destination && (
          <p className={styles.note}>Relay: {destination.url}</p>
        )}
        {client.status !== "ready" ? (
          <p>
            {client.status === "loading"
              ? "Opening your local identity…"
              : "Live identity access is unavailable. For development, set BUZZ_DEV_VIEWER to your Buzz public key in .env.local, then restart just web or just desktop. See README.md for requirements."}
          </p>
        ) : (
          <>
            {step === "destination" && (
              <>
                <p>
                  Use your identity across communities. Your profile and
                  conversations stay separate in each one.
                </p>
                <Field label="Relay URL">
                  <Input
                    type="url"
                    required
                    autoComplete="url"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="wss://relay.example.com"
                    maxLength={2048}
                    aria-describedby="relay-url-note"
                    disabled={busy}
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setDestination(undefined);
                      setCode("");
                      setAgreed(false);
                      setAdult(false);
                      setInfo(undefined);
                      setOriginal(undefined);
                      setProfile(client.profile);
                      setError("");
                    }}
                  />
                </Field>
                <p id="relay-url-note" className={styles.note}>
                  Enter a wss:// or https:// relay address without a path.
                  Continue contacts this relay using your Buzz identity; joining
                  or publishing a profile requires a later step.
                </p>
              </>
            )}
            {step === "access" && (
              <>
                <p>
                  Connect to <strong>{destination?.name}</strong> with your Buzz
                  identity.
                </p>
                <Field label="Invite code (if required)">
                  <Input
                    disabled={busy}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Existing members can leave this blank"
                    maxLength={256}
                  />
                </Field>
                {policy && (
                  <div className={styles.policy}>
                    {policy.terms_markdown && (
                      <a
                        href={`${destination?.url}/api/join-policy/terms`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Terms of Service ↗
                      </a>
                    )}
                    {policy.privacy_markdown && (
                      <a
                        href={`${destination?.url}/api/join-policy/privacy`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Privacy Notice ↗
                      </a>
                    )}
                    {(policy.terms_markdown || policy.privacy_markdown) && (
                      <Checkbox
                        checked={agreed}
                        onCheckedChange={setAgreed}
                        label="I agree to this community’s Terms of Service and Privacy Notice."
                      />
                    )}
                    {policy.age_attestation_required && (
                      <Checkbox
                        checked={adult}
                        onCheckedChange={setAdult}
                        label="I confirm that I am at least 18 years old."
                      />
                    )}
                  </div>
                )}
                <p className={styles.note}>
                  If access is denied, ask a community administrator for an
                  invite code.
                </p>
              </>
            )}
            {step === "profile" && (
              <>
                <p>
                  {mode === "profile"
                    ? "Your local default. Use it when joining communities; saving here does not publish changes to them."
                    : original?.exists
                      ? "Your existing community profile is loaded. Keep it or update it here."
                      : "Start with your local profile, or choose how you appear in this community."}
                </p>
                <ProfileFields
                  profile={profile}
                  onChange={setProfile}
                  disabled={busy}
                />
              </>
            )}
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            <footer className="mt-6 flex flex-wrap items-center justify-between gap-4">
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (step === "destination" || mode === "profile") close();
                  else {
                    setError("");
                    setStep(step === "profile" ? "access" : "destination");
                    setAgreed(false);
                    setAdult(false);
                  }
                }}
              >
                Back
              </Button>
              <Button
                variant="prominent"
                type="submit"
                disabled={
                  busy ||
                  (step === "access" && !allowed) ||
                  (step === "profile" && !canSaveProfile(profile))
                }
              >
                {busy
                  ? "Working…"
                  : step === "profile"
                    ? mode === "profile"
                      ? "Save profile"
                      : original?.exists &&
                          profile.name === original.profile.name &&
                          profile.picture === original.profile.picture
                        ? "Open community"
                        : "Publish profile & open"
                    : "Continue"}
              </Button>
            </footer>
          </>
        )}
      </form>
    </Dialog>
  );
}
