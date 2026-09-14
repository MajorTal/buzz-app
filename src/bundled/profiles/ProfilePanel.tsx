import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { IconCopy } from "@tabler/icons-react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { activityTarget } from "../../features/agents/activity-target";
import type { PanelProps } from "../../features/panels/service";
import { profileKey, profileTarget } from "../../features/profiles/target";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import styles from "./Profiles.module.css";

export function ProfilePanel({
  relay,
  target,
  context,
}: PanelProps & { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const pubkey = profileKey(target);
  if (!pubkey) return <p>Unsupported profile.</p>;
  if (connection.status !== "ready")
    return <p>Connect to a community to view this profile.</p>;
  return (
    <ProfileDetails
      key={`${connection.scope}:${connection.generation}:${pubkey}`}
      session={connection.session}
      pubkey={pubkey}
      context={context}
    />
  );
}
function ProfileDetails({
  session,
  pubkey,
  context,
}: {
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
}) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [pubkey]),
    [session.profiles, pubkey],
  );
  const profile = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  ).get(pubkey);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, retry] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    region.current?.focus();
  }, []);
  // Each target/session owns this completion; shared data work remains session-owned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery.
  useEffect(() => {
    let active = true;
    setStatus("loading");
    void session.profiles.ensure([pubkey]).then(
      () => {
        if (active) setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [session, pubkey, attempt]);
  const npub = profileTarget(pubkey)?.slice(6) ?? pubkey;
  const name = profile?.name ?? "Unknown profile";
  const activity = activityTarget(pubkey, context?.channelId);
  return (
    <section
      ref={region}
      data-buzz-ui=""
      aria-label="Profile details"
      tabIndex={-1}
      className={styles.root}
    >
      <div className={styles.identity}>
        <Avatar
          src={
            profile?.picture ? (session.media(profile.picture) ?? null) : null
          }
          alt={`${name} avatar`}
          fallback={profile?.name ?? "?"}
          size="large"
        />
        <h2 className="text-heading">{name}</h2>
      </div>
      {profile?.about && <p className={styles.about}>{profile.about}</p>}
      {context?.canOpen(activity) && (
        <div>
          <Button size="compact" onClick={() => context.open(activity)}>
            View activity
          </Button>
          <p className="text-body-sm text-secondary">
            Owner-only agent telemetry in this channel, if published.
          </p>
        </div>
      )}
      <div className={styles.publicKey}>
        <div className={styles.keyHeading}>
          <h3 className="text-body">Public key</h3>
          <Button
            size="compact"
            variant="ghost"
            aria-label="Copy npub"
            onClick={() => {
              setCopyStatus("");
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(npub))
                .then(
                  () => setCopyStatus("Public key copied."),
                  () =>
                    setCopyStatus(
                      "Could not copy. Select the public key above to copy it.",
                    ),
                );
            }}
          >
            <IconCopy size={16} aria-hidden="true" />
            Copy
          </Button>
        </div>
        <code className="font-mono text-mono">{npub}</code>
        <span role="status" className={styles.feedback}>
          {copyStatus}
        </span>
      </div>
      {!profile &&
        (status === "loading" ? (
          <p role="status">Loading profile…</p>
        ) : (
          <>
            <p role={status === "error" ? "alert" : undefined}>
              {status === "error"
                ? "Could not load this profile."
                : "No profile metadata is available in this community."}
            </p>
            <Button size="compact" onClick={() => retry((value) => value + 1)}>
              Retry profile
            </Button>
          </>
        ))}
    </section>
  );
}
