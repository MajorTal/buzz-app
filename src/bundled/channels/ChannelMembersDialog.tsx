import { motion, useReducedMotion } from "motion/react";
import { Button as BaseButton } from "@base-ui/react/button";
import referenceStyles from "../../shared/InlineReference.module.css";
import { npubEncode } from "nostr-tools/nip19";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { AgentControl } from "../../features/agents/control";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useIdentityNames } from "../../features/identity-names/react";
import { usePresenceStatus } from "../../features/presence/react";
import { profileTarget } from "../../features/profiles/target";
import styles from "./ChannelMembersDialog.module.css";
import { MEMBER_SEARCH_PAGE_SIZE } from "../../features/channel-members/search";
import { canAddMembers } from "../../features/channel-members/members";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  ArrowsClockwiseIcon,
  CircleNotchIcon,
  UsersIcon,
} from "../../shared/design-system/icons";
import {
  MemberRow,
  MemberAdministrationStatus,
  useMemberAdministration,
} from "./MemberAdministration";
import { useMemberSearch } from "./useMemberSearch";
import { useMemberOwners } from "./useMemberOwners";

/** Mounted rows share the same bounded presence owner as message bylines. */
function MemberAvatar({
  session,
  pubkey,
  name,
  picture,
  agent,
  descriptionId,
}: {
  session: RelaySession;
  pubkey: string;
  name: string;
  picture: string | undefined;
  agent: boolean;
  descriptionId: string;
}) {
  const presence = usePresenceStatus(session.presence, pubkey);
  return (
    <>
      <Avatar
        alt=""
        fallback={name}
        src={picture ? session.media(picture, "small") : undefined}
        size="default"
        shape={agent ? "squircle" : "circle"}
        statusBadge={presence === "unknown" ? undefined : presence}
      />
      <span className="sr-only" id={descriptionId}>
        {presence === "unknown" ? "" : `Presence: ${presence}`}
      </span>
    </>
  );
}

/** Query and loading changes must not rebuild unchanged row/menu trees. */
const MemberIdentityRow = memo(function MemberIdentityRow({
  session,
  channelId,
  pubkey,
  name,
  keyLabel,
  adding,
  picture,
  isAgent,
  roleLabel,
  archived,
  ownerName,
  target,
  clickable,
  ownerTarget,
  ownerClickable,
  descriptionId,
  reducedMotion,
  input,
  scrollport,
  focusedAdd,
  openProfile,
  onSendMessage,
  messagePending,
  add,
  busy,
  addDisabled,
}: {
  session: RelaySession;
  channelId: string;
  pubkey: string;
  name: string;
  keyLabel: string | undefined;
  adding: boolean;
  picture: string | undefined;
  isAgent: boolean;
  roleLabel: string | undefined;
  archived: boolean;
  ownerName: string;
  target: string | undefined;
  clickable: boolean;
  ownerTarget: string | undefined;
  ownerClickable: boolean;
  descriptionId: string;
  reducedMotion: boolean | null;
  input: React.RefObject<HTMLElement | null>;
  scrollport: React.RefObject<HTMLElement | null>;
  focusedAdd: React.RefObject<{
    key: string;
    button: HTMLButtonElement;
  } | null>;
  openProfile(destination: string | undefined): boolean;
  onSendMessage: ((key: string) => Promise<void>) | undefined;
  messagePending: boolean;
  add(key: string): Promise<void>;
  busy: boolean;
  addDisabled: boolean;
}) {
  const npub = npubEncode(pubkey);

  const expanded = {
    height: "auto",
    marginTop: "var(--space-half)",
    opacity: 1,
  };
  const avatar = (
    <MemberAvatar
      session={session}
      pubkey={pubkey}
      name={name}
      picture={picture}
      agent={!!isAgent}
      descriptionId={descriptionId}
    />
  );
  const viewProfile = () => openProfile(target);
  const identity = (
    <div className={styles.profileContent}>
      {clickable && (
        <div className={styles.profileHitTarget}>
          <NavigationItem
            label=""
            icon={avatar}
            aria-label={`Open profile for ${name} (${keyLabel})${isAgent ? ", agent" : ""}${adding ? ", not in this channel" : roleLabel ? `, ${roleLabel}` : ""}${!adding && archived ? ", archived" : ""}`}
            aria-describedby={descriptionId}
            onClick={viewProfile}
          />
        </div>
      )}
      <div
        className={styles.staticProfile}
        data-profile-link={clickable || undefined}
      >
        {!clickable && avatar}
        <span className="min-w-0 flex-1">
          <span className={styles.identity}>
            <span className={styles.identityName}>
              <span className={`${styles.name} text-body-sm`}>
                {name}
                {pubkey === session.viewer ? " (you)" : ""}
              </span>
            </span>
            {ownerName && (
              <span className={styles.manager}>
                {" managed by "}
                {ownerClickable ? (
                  <BaseButton
                    className={referenceStyles.link}
                    aria-label={`Open owner profile: ${ownerName}`}
                    onClick={() => openProfile(ownerTarget)}
                  >
                    {ownerName}
                  </BaseButton>
                ) : (
                  ownerName
                )}
              </span>
            )}
          </span>
          <motion.span
            className={styles.metadata}
            variants={{
              rest: { height: 0, marginTop: 0, opacity: 0 },
              revealed: expanded,
              focused: { ...expanded, transition: { duration: 0 } },
            }}
            transition={{
              duration: reducedMotion ? 0 : 0.14,
              ease: [0.23, 1, 0.32, 1],
            }}
          >
            <span className={styles.metadataContent}>
              <span
                className={`${styles.publicKey} text-mono text-body-sm text-subtle`}
                aria-hidden="true"
              >
                {`${npub.slice(0, 11)}…${npub.slice(-6)}`}
              </span>
            </span>
          </motion.span>
        </span>
      </div>
    </div>
  );
  return (
    <MemberRow
      session={session}
      channelId={channelId}
      pubkey={pubkey}
      name={name}
      returnFocus={input}
      scrollport={scrollport}
      onViewProfile={clickable ? viewProfile : undefined}
      onViewOwnerProfile={
        ownerClickable ? () => openProfile(ownerTarget) : undefined
      }
      onSendMessage={
        onSendMessage ? () => void onSendMessage(pubkey) : undefined
      }
      messagePending={messagePending}
      invitationAction={
        adding ? (
          <span className={styles.addAction}>
            <Button
              variant="prominent"
              size="xs"
              aria-label={`Add ${name} (${keyLabel})`}
              aria-disabled={busy || undefined}
              disabled={addDisabled}
              onBlur={(event) => {
                if (focusedAdd.current?.button === event.currentTarget)
                  focusedAdd.current = null;
              }}
              onClick={(event) => {
                if (busy) return;
                if (document.activeElement === event.currentTarget)
                  focusedAdd.current = {
                    key: pubkey,
                    button: event.currentTarget,
                  };
                void add(pubkey);
              }}
            >
              {busy ? "Adding…" : "Add"}
            </Button>
          </span>
        ) : undefined
      }
    >
      {identity}
    </MemberRow>
  );
});

type MemberNavigation = {
  onOpenConversation?: ((channelId: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  onOpenLink?:
    | ((target: string, returnFocus?: HTMLElement) => boolean)
    | undefined;
};

export function ChannelMembersButton({
  session,
  channelId,
  control,
  canOpenLink,
  onOpenLink,
  onOpenConversation,
  presentation,
}: {
  session: RelaySession;
  channelId: string;
  control?: AgentControl | undefined;
  presentation?:
    | { open: boolean; onOpenChange(open: boolean): void }
    | undefined;
} & MemberNavigation) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = presentation ? presentation.open : localOpen;
  const setOpen = presentation ? presentation.onOpenChange : setLocalOpen;
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={trigger}
        size="sm"
        aria-label="Channel members"
        title="Channel members"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        icon={<UsersIcon size="1rem" aria-hidden="true" />}
      />
      {open && (
        <ChannelMembersDialog
          key={channelId}
          session={session}
          channelId={channelId}
          control={control}
          canOpenLink={canOpenLink}
          onOpenLink={onOpenLink}
          onOpenConversation={onOpenConversation}
          close={() => setOpen(false)}
          trigger={trigger}
        />
      )}
    </>
  );
}

/** Members are shared relay truth; only search and in-progress presentation belong to this dialog. */
export function ChannelMembersDialog({
  session,
  channelId,
  control,
  close,
  trigger,
  canOpenLink,
  onOpenLink,
  onOpenConversation,
}: {
  session: RelaySession;
  channelId: string;
  control?: AgentControl | undefined;
  close(): void;
  trigger: React.RefObject<HTMLButtonElement | null>;
} & MemberNavigation) {
  const reducedMotion = useReducedMotion();
  const presenceId = useId();
  const openingDestination = useRef(false);
  const messagePending = useRef(false);
  const [openingMessage, setOpeningMessage] = useState(false);
  const [messageError, setMessageError] = useState("");
  const input = useRef<HTMLElement>(null);
  const scrollport = useRef<HTMLElement>(null);
  const focusedAdd = useRef<{ key: string; button: HTMLButtonElement } | null>(
    null,
  );
  const lifetime = useRef<AbortController>(undefined);
  const [query, setQuery] = useState("");
  const [selectedRole, setSelectedRole] = useState("All");
  const additions = useSyncExternalStore(
    session.memberAdditions.subscribe,
    session.memberAdditions.snapshot,
    session.memberAdditions.snapshot,
  ).filter((item) => item.channelId === channelId);
  const busy = new Set(
    additions.filter((item) => item.pending).map((item) => item.pubkey),
  );
  const errors = Object.fromEntries(
    additions
      .filter((item) => item.error)
      .map((item) => [item.pubkey, item.error]),
  );
  const [notice, setNotice] = useState("");
  const [rosterError, setRosterError] = useState("");
  const [nameError, setNameError] = useState("");
  const [rosterBusy, setRosterBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [namesSettledFor, setNamesSettledFor] = useState<{
    session: RelaySession;
    memberKey: string;
  }>();
  const [agentsBusy, setAgentsBusy] = useState(false);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
    session.archives.snapshot,
  );
  const agents = useAgentChoices(session);
  const resolveName = useIdentityNames(session.names);
  const channel =
    list.channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const canAdd = canAddMembers(session, channel);
  const text = query.trim();
  const [invitationPage, setInvitationPage] = useState({
    text,
    size: MEMBER_SEARCH_PAGE_SIZE,
  });
  if (invitationPage.text !== text)
    setInvitationPage({ text, size: MEMBER_SEARCH_PAGE_SIZE });
  // biome-ignore lint/correctness/useExhaustiveDependencies: destination changes retire addition notices.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setAgentsBusy(false);
    messagePending.current = false;
    setOpeningMessage(false);
    setMessageError("");
    return () => {
      controller.abort();
      lifetime.current = undefined;
    };
  }, [session, channelId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly retries the roster read.
  useEffect(() => {
    let current = true;
    setRosterBusy(true);
    setRosterError("");
    void session
      .read([{ kinds: [39002], "#d": [channelId], limit: 1 }], { fresh: true })
      .then(
        (events) => {
          if (
            current &&
            !events.some(
              (event) =>
                event.kind === 39002 &&
                event.tags.some(
                  ([tag, value]) => tag === "d" && value === channelId,
                ),
            )
          )
            setRosterError(
              "The member list could not be confirmed. Try again.",
            );
        },
        () => {
          if (current)
            setRosterError("The member list could not load. Try again.");
        },
      )
      .finally(() => {
        if (current) setRosterBusy(false);
      });
    void session.archives.ensure();
    return () => {
      current = false;
    };
  }, [session, channelId, refresh]);
  const memberKey = channel?.members?.join(":") ?? "";
  const administration = useMemberAdministration(
    session,
    channelId,
    memberKey,
    !!channel && !channel.cached,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh retries missing names with the other dialog reads.
  useEffect(() => {
    setNameError("");
    setNamesSettledFor(undefined);
    if (!memberKey) {
      setNamesSettledFor({ session, memberKey });
      return;
    }
    let current = true;
    void session.profiles
      .ensure(memberKey.split(":"), "foreground")
      .catch(() => {
        if (current)
          setNameError(
            "Some names could not load. Public keys still identify members. Try again.",
          );
      })
      .finally(() => {
        if (current) setNamesSettledFor({ session, memberKey });
      });
    return () => {
      current = false;
    };
  }, [session, memberKey, refresh]);
  const namesBusy =
    namesSettledFor?.session !== session ||
    namesSettledFor?.memberKey !== memberKey;
  // Reopen immediately only when the session already has a resolved presentation.
  // This is a reveal latch, not a second roster/profile/permission cache.
  const [revealedFor, setRevealedFor] = useState(() =>
    channel &&
    !channel.cached &&
    (administration.status === "ready" || administration.status === "error") &&
    (channel.members ?? []).every((key) => profiles.has(key))
      ? session
      : undefined,
  );
  const rolesSettled =
    administration.status === "ready" ||
    administration.status === "error" ||
    !channel ||
    channel.cached;
  useEffect(() => {
    // The authority hook may have started a new roster's read in this effect
    // flush. Do not reveal using the previous render's settled role snapshot.
    const status = session.memberAdministration.snapshot(channelId).status;
    if (!rosterBusy && !namesBusy && rolesSettled && status !== "loading")
      setRevealedFor(session);
  }, [session, channelId, rosterBusy, namesBusy, rolesSettled]);
  const initialLoading = revealedFor !== session;
  const known = useMemo(
    () => new Map(agents.identities.map((agent) => [agent.pubkey, agent])),
    [agents.identities],
  );
  const members = new Set(channel?.members ?? []);
  const archived = new Set(archives.archived);
  const label = (key: string, fallback?: string) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        fallback ??
        formatPublicKey(key) ??
        "Unknown member",
    );
  const matches = (key: string, name: string) =>
    `${name} ${key} ${npubEncode(key)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  const currentMembers = [...members].sort(
    (a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b),
  );
  const groups = ["Owners", "Admins", "Members", "Agents"].map((name) => {
    const keys = currentMembers.filter((key) => {
      const role = administration.authority.roles[key];
      const group =
        role === "owner"
          ? "Owners"
          : role === "admin"
            ? "Admins"
            : known.has(key) || profiles.get(key)?.isAgent
              ? "Agents"
              : "Members";
      return group === name;
    });
    return {
      name,
      count: keys.length,
      keys: keys.filter((key) => matches(key, label(key))),
    };
  });
  const presentGroups = groups.filter((group) => group.count > 0);
  const roleFilter =
    query.length === 0 &&
    presentGroups.length > 1 &&
    presentGroups.some((group) => group.name === selectedRole)
      ? selectedRole
      : "All";
  if (
    !initialLoading &&
    administration.status !== "loading" &&
    selectedRole !== roleFilter
  )
    setSelectedRole(roleFilter);
  const filteredGroups = groups.filter(
    (group) => roleFilter === "All" || group.name === roleFilter,
  );
  const search = useMemberSearch(session, query, canAdd);
  const candidates = new Map(
    search.people.map((person) => [person.pubkey, person]),
  );
  if (query.trim())
    for (const agent of agents.identities) {
      if (matches(agent.pubkey, label(agent.pubkey, agent.name)))
        candidates.set(agent.pubkey, {
          pubkey: agent.pubkey,
          name: agent.name,
          isAgent: true,
        });
    }
  const available = [...candidates.values()].filter(
    (person) => !members.has(person.pubkey) && !archived.has(person.pubkey),
  );
  // Known agents supplement the server page, not its rendering bound. Keep all
  // matches reachable through the existing More action without mounting them all.
  const invitationSize =
    invitationPage.text === text
      ? invitationPage.size
      : MEMBER_SEARCH_PAGE_SIZE;
  const visibleCandidates =
    roleFilter === "All" ? available.slice(0, invitationSize) : [];
  const moreCandidates = available.length > invitationSize;
  // Keep roster ownership observed while filtering; retiring the view clears
  // valid hints and forces every retained agent row through recovery renders.
  const agentKeys = [
    ...new Set([
      ...currentMembers.filter(
        (key) => known.has(key) || profiles.get(key)?.isAgent,
      ),
      ...visibleCandidates
        .filter(
          (person) =>
            person.isAgent ||
            known.has(person.pubkey) ||
            profiles.get(person.pubkey)?.isAgent,
        )
        .map((person) => person.pubkey),
    ]),
  ]
    .sort()
    .join(":");
  const ownership = useMemberOwners(session, agentKeys, refresh);
  const refreshing =
    ownership.busy ||
    rosterBusy ||
    administration.status === "loading" ||
    namesBusy ||
    search.loading ||
    agents.pending ||
    agentsBusy ||
    archives.status === "loading";
  const mutationPending =
    busy.size > 0 || administration.operation?.status === "pending";
  const refreshMembers = () => {
    if (refreshing || mutationPending) return;
    setRosterBusy(true);
    setRefresh((value) => value + 1);
    setInvitationPage({ text, size: MEMBER_SEARCH_PAGE_SIZE });
    void session.memberAdministration.refresh(channelId).catch(() => {});
    // Native inventory retains ready data during refresh, so its snapshot alone
    // does not expose every in-flight read.
    const signal = lifetime.current?.signal;
    setAgentsBusy(true);
    void session.agentChoices.refresh().finally(() => {
      if (!signal?.aborted) setAgentsBusy(false);
    });
    void session.archives.refresh();
    search.refresh();
  };
  const keys = publicKeyLabels([...members, ...candidates.keys()]);
  // A confirmed addition replaces its focused Add button with a member row.
  // DOM removal does not emit blur, so restore focus only if it was not moved elsewhere.
  useLayoutEffect(() => {
    const previous = focusedAdd.current;
    if (!previous || !memberKey.split(":").includes(previous.key)) return;
    focusedAdd.current = null;
    if (
      document.activeElement === previous.button ||
      document.activeElement === document.body
    )
      input.current?.focus();
  }, [memberKey]);
  const add = useCallback(
    async (key: string) => {
      const signal = lifetime.current?.signal;
      if (!signal) return;
      setNotice("");
      try {
        await session.memberAdditions.add(channelId, key, control);
        if (!signal.aborted)
          setNotice(
            `${session.names.resolve(key, session.profiles.snapshot().get(key)?.name ?? formatPublicKey(key) ?? "Unknown member")} is in the channel.`,
          );
      } catch {
        // Session-owned recovery remains visible if this dialog closes and reopens.
      }
    },
    [session, channelId, control],
  );

  const searchAgents = search.people
    .filter((person) => person.isAgent)
    .map((person) => person.pubkey)
    .sort()
    .join(":");
  const openMessage = useCallback(
    async (key: string) => {
      const signal = lifetime.current?.signal;
      if (
        !signal ||
        signal.aborted ||
        messagePending.current ||
        !onOpenConversation ||
        !session.directMessages.available ||
        !session.viewer ||
        key === session.viewer ||
        known.has(key) ||
        profiles.get(key)?.isAgent ||
        searchAgents.split(":").includes(key) ||
        administration.authority.roles[key] === "bot"
      )
        return;
      messagePending.current = true;
      setOpeningMessage(true);
      setMessageError("");
      try {
        const destination = await session.directMessages.open([key], signal);
        if (signal.aborted) return;
        // The destination owns focus; closing Members must not return it to this header.
        openingDestination.current = true;
        if (onOpenConversation(destination)) close();
        else {
          openingDestination.current = false;
          setMessageError(
            "Could not open the conversation. Try Send message again.",
          );
        }
      } catch (reason) {
        openingDestination.current = false;
        if (!signal.aborted)
          setMessageError(
            reason instanceof Error
              ? reason.message
              : "Could not open the conversation. Try Send message again.",
          );
      } finally {
        if (!signal.aborted) {
          messagePending.current = false;
          setOpeningMessage(false);
        }
      }
    },
    [
      session,
      onOpenConversation,
      close,
      profiles,
      known,
      searchAgents,
      administration.authority.roles,
    ],
  );

  const openProfile = useCallback(
    (destination: string | undefined) => {
      if (!destination || !canOpenLink?.(destination)) return false;
      openingDestination.current = true;
      if (onOpenLink?.(destination, trigger.current ?? undefined)) {
        close();
        return true;
      }
      openingDestination.current = false;
      return false;
    },
    [canOpenLink, onOpenLink, trigger, close],
  );
  const row = (
    key: string,
    name: string,
    adding: boolean,
    picture?: string,
    agent?: boolean,
  ) => {
    const role = administration.authority.roles[key];
    const isAgent = !!(agent || known.has(key) || profiles.get(key)?.isAgent);
    const owner = isAgent ? ownership.owners.get(key) : undefined;
    const target = profileTarget(key);
    const ownerTarget = owner ? profileTarget(owner) : undefined;
    return (
      <MemberIdentityRow
        key={key}
        session={session}
        channelId={channelId}
        pubkey={key}
        name={name}
        keyLabel={keys.get(key)}
        adding={adding}
        picture={picture ?? profiles.get(key)?.picture}
        isAgent={isAgent}
        archived={archived.has(key)}
        roleLabel={
          isAgent && role === "bot"
            ? "member"
            : (role ??
              (administration.status === "idle" ||
              administration.status === "loading"
                ? undefined
                : "Role unverified"))
        }
        ownerName={
          owner
            ? `${label(owner)}${owner === session.viewer ? " (you)" : ""}`
            : ""
        }
        target={target}
        clickable={!!target && !!onOpenLink && !!canOpenLink?.(target)}
        ownerTarget={ownerTarget}
        ownerClickable={
          !!ownerTarget && !!onOpenLink && !!canOpenLink?.(ownerTarget)
        }
        descriptionId={`${presenceId}-${key}`}
        reducedMotion={reducedMotion}
        input={input}
        scrollport={scrollport}
        focusedAdd={focusedAdd}
        openProfile={openProfile}
        onSendMessage={
          !isAgent &&
          role !== "bot" &&
          key !== session.viewer &&
          session.viewer &&
          session.directMessages.available &&
          onOpenConversation
            ? openMessage
            : undefined
        }
        messagePending={openingMessage}
        add={add}
        busy={busy.has(key)}
        addDisabled={rosterBusy || !!rosterError}
      />
    );
  };
  return (
    <Dialog
      open
      dismissOnOutsideClick
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Channel members"
      height="stable"
      bodyLayout="flex"
      description={channel?.name}
      closeLabel="Close channel members"
      headerActions={
        <IconButton
          variant="ghost"
          size="compact"
          aria-label="Refresh member data"
          title="Refresh member data"
          aria-busy={refreshing}
          disabled={refreshing || mutationPending}
          focusableWhenDisabled
          onClick={refreshMembers}
          icon={
            <ArrowsClockwiseIcon
              size={16}
              aria-hidden="true"
              className={
                refreshing && !initialLoading
                  ? "motion-safe:animate-spin"
                  : undefined
              }
            />
          }
        />
      }
      initialFocus={input}
      finalFocus={() => (openingDestination.current ? false : trigger.current)}
    >
      <div className={styles.layout}>
        <div className="flex shrink-0 items-center">
          <div className="min-w-0 flex-1">
            <SearchField
              inputRef={input}
              label="Search people and agents"
              placeholder={canAdd ? "Add people and agents" : "Search members"}
              value={query}
              onValueChange={(value) => {
                setQuery(value);
                if (value.length > 0) setSelectedRole("All");
              }}
              maxLength={256}
            />
          </div>
          {!initialLoading && presentGroups.length > 1 && (
            <motion.div
              className="shrink-0 overflow-hidden"
              initial={false}
              animate={
                query.length > 0
                  ? { width: 0, opacity: 0, marginLeft: 0 }
                  : { width: "auto", opacity: 1, marginLeft: "var(--space-2)" }
              }
              transition={{
                duration: reducedMotion ? 0 : 0.14,
                ease: [0.23, 1, 0.32, 1],
              }}
              inert={query.length > 0}
              aria-hidden={query.length > 0 || undefined}
            >
              <Select
                variant="compact"
                label="Filter members by role"
                align="end"
                value={roleFilter}
                valueLabel={roleFilter}
                groups={[
                  {
                    label: "",
                    options: [
                      { name: "All", count: members.size },
                      ...presentGroups,
                    ].map((group) => ({
                      value: group.name,
                      label: `${group.name} · ${group.count}`,
                    })),
                  },
                ]}
                onValueChange={(value) => {
                  setSelectedRole(value);
                  if (scrollport.current) scrollport.current.scrollTop = 0;
                }}
              />
            </motion.div>
          )}
        </div>
        <section
          ref={scrollport}
          className={styles.memberList}
          aria-label="Member list"
        >
          {!canAdd && (
            <p className="text-body-sm text-subtle">
              {channel?.channelType === "dm"
                ? "DM membership cannot be changed here."
                : channel?.archived
                  ? "Archived channels cannot add members."
                  : !session.outbox?.supports(9000)
                    ? "Adding members is unavailable in this connection."
                    : "Join this channel to add people and agents."}
            </p>
          )}
          {rosterError && (
            <p role="alert" className="text-body-sm text-danger">
              {rosterError}
            </p>
          )}
          <MemberAdministrationStatus session={session} channelId={channelId} />
          {initialLoading ? (
            <div
              className={styles.loadingMembers}
              role="status"
              aria-label="Loading members"
            >
              <CircleNotchIcon
                size={24}
                aria-hidden="true"
                className="motion-safe:animate-spin"
              />
              <span className="sr-only">Loading members…</span>
            </div>
          ) : (
            filteredGroups
              .filter(
                (group) =>
                  group.keys.length ||
                  group.name ===
                    (roleFilter === "All" ? "Members" : roleFilter),
              )
              .map((group) => (
                <section key={group.name} aria-label={group.name}>
                  <h3
                    className={`${styles.groupHeading} px-control-inset pb-2 text-caption text-subtle`}
                  >
                    {group.name} · {group.count}
                  </h3>
                  <ul>
                    {group.keys.map((key) => row(key, label(key), false))}
                  </ul>
                  {!filteredGroups.some((item) => item.keys.length) &&
                    !rosterBusy && (
                      <p className="px-control-inset text-body-sm text-subtle">
                        {query
                          ? "No members match your search."
                          : "No members to show."}
                      </p>
                    )}
                </section>
              ))
          )}
          {!initialLoading &&
            canAdd &&
            roleFilter === "All" &&
            query.trim() && (
              <section
                className={styles.memberGroup}
                aria-label="Not in this channel"
              >
                <h3
                  className={`${styles.groupHeading} px-control-inset pb-2 text-caption text-subtle`}
                >
                  Not in this channel
                </h3>
                {visibleCandidates.map((person) =>
                  row(
                    person.pubkey,
                    label(person.pubkey, person.name),
                    true,
                    person.picture,
                    person.isAgent,
                  ),
                )}
                {search.loading && (
                  <p
                    role="status"
                    className="px-control-inset text-body-sm text-subtle"
                  >
                    Searching…
                  </p>
                )}
                {!search.loading && !search.error && !available.length && (
                  <p className="px-control-inset text-body-sm text-subtle">
                    No other matching people or agents.
                  </p>
                )}
                {search.error && (
                  <p
                    role="alert"
                    className="px-control-inset text-body-sm text-danger"
                  >
                    {search.error}
                  </p>
                )}
                {(moreCandidates || search.more) && (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setInvitationPage({
                          text,
                          size: invitationSize + MEMBER_SEARCH_PAGE_SIZE,
                        });
                        if (!moreCandidates) search.next();
                      }}
                      disabled={search.loading}
                    >
                      Show more results
                    </Button>
                  </div>
                )}
              </section>
            )}
          {nameError && (
            <p role="status" className="text-body-sm text-subtle">
              {nameError}
            </p>
          )}
          {ownership.failed && (
            <p role="status" className="text-body-sm text-subtle">
              Some agent managers or their names could not load. Try again.
            </p>
          )}
          {agents.error && (
            <p role="alert" className="text-body-sm text-danger">
              Some agents could not load.
            </p>
          )}
          {archives.status === "error" && (
            <p role="alert" className="text-body-sm text-danger">
              Archived identities could not be checked.
            </p>
          )}
          {Object.entries(errors).map(([key, error]) => (
            <p role="alert" key={key} className="text-body-sm text-danger">
              {label(key)}: {error}{" "}
              {!additions.find((item) => item.pubkey === key)?.removed && (
                <Button
                  variant="outline"
                  disabled={busy.has(key) || !canAdd}
                  onClick={() => void add(key)}
                >
                  {busy.has(key) ? "Retrying…" : "Retry"}
                </Button>
              )}
            </p>
          ))}
          {openingMessage && (
            <p role="status" className="text-body-sm text-subtle">
              Opening conversation…
            </p>
          )}
          {messageError && (
            <p role="alert" className="text-body-sm text-danger">
              {messageError}
            </p>
          )}
          {notice && (
            <p role="status" className="text-body-sm text-subtle">
              {notice}
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
