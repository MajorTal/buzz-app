import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import {
  communityRequest,
  inspectProfile,
  publishProfile,
  type CommunityInfo,
} from "./api";
import type {
  Communities,
  CommunityAccount,
  ClientSnapshot,
  PersonalProfile,
} from "./service";
import { readErrorKind } from "../relay/errors";
import { canSaveProfile, ProfileFields } from "./ProfileFields";
import { communityDestination, relayOrigin } from "./destination";
import { registerBrokerCommunity } from "../relay/transport";
import styles from "./Communities.module.css";

type Props = {
  communities: Communities;
  mode: "join" | "profile";
  close(): void;
  onJoined?: (id: string) => void;
};
export function CommunityDialog(props: Props) {
  const client = useSyncExternalStore(
    props.communities.subscribe,
    props.communities.snapshot,
  );
  return (
    <AccountDialog
      key={`${client.epoch}:${client.status}:${props.mode}`}
      {...props}
      client={client}
    />
  );
}
function AccountDialog({
  communities,
  mode,
  close,
  onJoined,
  client,
}: Props & { client: ClientSnapshot }) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Never acquire a newer account on submit or after an asynchronous response.
  const [account] = useState(() =>
    client.status === "ready" ? communities.capture() : null,
  );
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
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
    };
  }, []);
  function assertCurrent() {
    if (!mounted.current || !account)
      throw new Error("This account draft is no longer available");
    communities.assertCurrent(account);
    return account;
  }
  function isCurrent() {
    try {
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  }
  async function work(action: (account: CommunityAccount) => Promise<void>) {
    try {
      const captured = assertCurrent();
      setBusy(true);
      setError("");
      await action(captured);
    } catch (reason) {
      if (isCurrent())
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  const policy = info?.policy;
  const allowed =
    (!policy?.age_attestation_required || adult) &&
    (!(policy?.terms_markdown || policy?.privacy_markdown) || agreed);
  async function submit() {
    if (step === "destination") {
      await work(async (account) => {
        const next = communityDestination(relayOrigin(url));
        setDestination(next);
        await registerBrokerCommunity(
          next.id,
          AbortSignal.any([account.signal, AbortSignal.timeout(12000)]),
        );
        assertCurrent();
        const value = await communityRequest<CommunityInfo>(
          next.id,
          "info",
          undefined,
          account,
        );
        assertCurrent();
        // Restoring an existing admitted profile is not a new join or policy acceptance.
        const found = await inspectProfile(next.id, account).catch(
          (reason: unknown) => {
            // Denial may require admission; outages/invalid replies are not absence.
            if (readErrorKind(reason) === "denied") return undefined;
            throw reason;
          },
        );
        assertCurrent();
        setInfo(value);
        if (found?.exists) {
          setOriginal(found);
          setProfile(found.profile);
          setStep("profile");
        } else setStep("access");
      });
    } else if (step === "access") {
      if (!allowed) return;
      await work(async (account) => {
        if (code.trim()) {
          let receipt: string | undefined;
          if (policy) {
            receipt = (
              await communityRequest<{ receipt: string }>(
                id,
                "accept-policy",
                {
                  code: code.trim(),
                  policy_version: policy.version,
                  age_confirmed: adult,
                },
                account,
              )
            ).receipt;
            assertCurrent();
          }
          const claim = await communityRequest<{ status: string }>(
            id,
            "claim",
            { code: code.trim(), policy_receipt: receipt },
            account,
          );
          assertCurrent();
          if (!["joined", "already_member"].includes(claim.status))
            throw new Error("Membership was not confirmed");
        }
        const found = await inspectProfile(id, account);
        assertCurrent();
        setOriginal(found);
        setProfile(found.exists ? found.profile : client.profile);
        setStep("profile");
      });
    } else {
      if (!profile.name.trim()) return;
      await work(async (account) => {
        if (mode === "profile")
          communities.saveProfile(
            { ...profile, name: profile.name.trim() },
            account,
          );
        else {
          if (!destination) throw new Error("Choose a community first");
          if (
            !original?.exists ||
            profile.name !== original.profile.name ||
            profile.picture !== original.profile.picture
          )
            await publishProfile(
              id,
              profile,
              original?.existing ?? {},
              account,
            );
          assertCurrent();
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
            account,
          );
          assertCurrent();
          onJoined?.(id);
        }
        assertCurrent();
        close();
      });
    }
  }
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <h2>
            {mode === "profile"
              ? "Your profile"
              : step === "profile"
                ? `Your profile in ${info?.name && info.name !== "Buzz Relay" ? info.name : destination?.name}`
                : "Add a community"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
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
                <label>
                  Relay URL
                  <input
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
                </label>
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
                <label>
                  Invite code <span className={styles.note}>(if required)</span>
                  <input
                    disabled={busy}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Existing members can leave this blank"
                    maxLength={256}
                  />
                </label>
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
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={agreed}
                          onChange={(e) => setAgreed(e.target.checked)}
                        />
                        I agree to this community’s Terms of Service and Privacy
                        Notice.
                      </label>
                    )}
                    {policy.age_attestation_required && (
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={adult}
                          onChange={(e) => setAdult(e.target.checked)}
                        />
                        I confirm that I am at least 18 years old.
                      </label>
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
            <footer>
              <button
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
              </button>
              <button
                className={styles.primary}
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
              </button>
            </footer>
          </>
        )}
      </form>
    </dialog>
  );
}
