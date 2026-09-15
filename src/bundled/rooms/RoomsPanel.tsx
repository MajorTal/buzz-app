import { nip19 } from "nostr-tools";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ChevronDown,
  Headphones,
  Mic,
  MicOff,
  Pencil,
  Plus,
  Radio,
  Settings,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import { Avatar } from "../../shared/Avatar";
import { connectLiveAudio } from "./audio";
import type { LiveAudioSession, LiveAudioState } from "./audio";
import {
  createLiveRoom,
  deleteLiveRoom,
  inviteToLiveRoom,
  LIVE_ROOM_PREFIX,
  renameLiveRoom,
} from "./api";
import styles from "./RoomsPanel.module.css";

type Sheet = "create" | "invite" | "rename" | "delete";

const isLiveRoom = (channel: ChannelSummary) =>
  channel.channelType === "stream" &&
  channel.name.startsWith(LIVE_ROOM_PREFIX) &&
  !channel.archived;

const displayName = (room: ChannelSummary) =>
  room.name.slice(LIVE_ROOM_PREFIX.length);

const memberCountLabel = (count: number) =>
  `${count} member${count === 1 ? "" : "s"}`;

export function RoomsPanel({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const channelList = useSyncExternalStore(
    connection.session.channels.subscribeList,
    connection.session.channels.list,
    connection.session.channels.list,
  );
  const profiles = useSyncExternalStore(
    connection.session.profiles.subscribe,
    connection.session.profiles.snapshot,
    connection.session.profiles.snapshot,
  );
  const [roomId, setRoomId] = useState("");
  const [optimisticRoom, setOptimisticRoom] = useState<ChannelSummary>();
  const [deletedRoomIds, setDeletedRoomIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const rooms = useMemo(
    () =>
      channelList.channels.filter(
        (channel) => isLiveRoom(channel) && !deletedRoomIds.has(channel.id),
      ),
    [channelList.channels, deletedRoomIds],
  );
  const [switching, setSwitching] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>();
  const [draft, setDraft] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [operationError, setOperationError] = useState("");
  const [newRoomIds, setNewRoomIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [roomNotice, setRoomNotice] = useState<ChannelSummary>();
  const knownRoomIds = useRef<Set<string> | undefined>(undefined);
  const knownRoomsScope = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);
  const [audio, setAudio] = useState<LiveAudioState>();
  const audioSession = useRef<LiveAudioSession | undefined>(undefined);
  const audioJoinAbort = useRef<AbortController | undefined>(undefined);
  const audioGeneration = useRef(0);
  const audioScope = useRef(connection.scope);
  const room =
    (optimisticRoom?.id === roomId ? optimisticRoom : undefined) ??
    rooms.find((candidate) => candidate.id === roomId) ??
    rooms[0];

  useEffect(
    () => connection.session.channels.ensureList(),
    [connection.session],
  );
  useEffect(() => {
    if (knownRoomsScope.current !== connection.scope) {
      knownRoomsScope.current = connection.scope;
      knownRoomIds.current = undefined;
      setNewRoomIds(new Set());
      setRoomNotice(undefined);
    }
    if (channelList.status !== "ready") return;
    const current = new Set(rooms.map(({ id }) => id));
    const known = knownRoomIds.current;
    knownRoomIds.current = current;
    if (!known) return;
    const added = rooms.filter(({ id }) => !known.has(id));
    if (!added.length) return;
    setNewRoomIds((ids) => {
      const next = new Set(ids);
      for (const candidate of added) next.add(candidate.id);
      return next;
    });
    setRoomNotice(added[0]);
  }, [channelList.status, connection.scope, rooms]);
  useEffect(() => {
    if (!roomId && rooms[0]) setRoomId(rooms[0].id);
    if (optimisticRoom && rooms.some(({ id }) => id === optimisticRoom.id))
      setOptimisticRoom(undefined);
  }, [optimisticRoom, roomId, rooms]);
  useEffect(() => {
    const pubkeys = [
      ...(room?.members ?? []),
      ...(audio?.peers.map((peer) => peer.pubkey) ?? []),
    ];
    if (pubkeys.length)
      void connection.session.profiles.ensure(pubkeys, "background");
  }, [audio?.peers, connection.session, room?.members]);
  useEffect(
    () => () => {
      audioGeneration.current++;
      audioJoinAbort.current?.abort();
      audioJoinAbort.current = undefined;
      audioSession.current?.leave();
      audioSession.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (audioScope.current === connection.scope) return;
    audioScope.current = connection.scope;
    audioGeneration.current++;
    audioJoinAbort.current?.abort();
    audioJoinAbort.current = undefined;
    audioSession.current?.leave();
    audioSession.current = undefined;
    setAudio(undefined);
    setCheckedIn(false);
  }, [connection.scope]);

  const leaveAudio = () => {
    audioGeneration.current++;
    audioJoinAbort.current?.abort();
    audioJoinAbort.current = undefined;
    audioSession.current?.leave();
    audioSession.current = undefined;
    setAudio(undefined);
  };
  const checkOut = () => {
    leaveAudio();
    setCheckedIn(false);
  };
  const selectRoom = (id: string) => {
    if (id !== room?.id) checkOut();
    setNewRoomIds((ids) => {
      if (!ids.has(id)) return ids;
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
    setRoomNotice((notice) => (notice?.id === id ? undefined : notice));
    setRoomId(id);
    setSwitching(false);
    setOptionsOpen(false);
    setOperationError("");
  };
  const joinAudio = async () => {
    if (!room || connection.status !== "ready" || audio) return;
    const generation = ++audioGeneration.current;
    const controller = new AbortController();
    audioJoinAbort.current?.abort();
    audioJoinAbort.current = controller;
    setOperationError("");
    setAudio({
      status: "connecting",
      muted: true,
      outputMuted: false,
      micLevel: 0,
      peers: [],
    });
    try {
      const session = await connectLiveAudio({
        connection,
        roomId: room.id,
        roomMembers: room.members ?? [],
        onState: (state) => {
          if (audioGeneration.current === generation) setAudio(state);
        },
        signal: controller.signal,
      });
      if (audioGeneration.current !== generation) {
        session.leave();
        return;
      }
      audioSession.current = session;
    } catch (error) {
      if (audioGeneration.current !== generation) return;
      audioJoinAbort.current = undefined;
      setAudio(undefined);
      const reason =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "We couldn’t connect you to the live room. Try again.";
      setOperationError(reason);
    }
  };
  const createRoom = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    setOperationError("");
    try {
      const created = await createLiveRoom(connection, name);
      knownRoomIds.current?.add(created.roomId);
      setOptimisticRoom({
        id: created.roomId,
        name: `${LIVE_ROOM_PREFIX}${name}`,
        channelType: "stream",
        members: connection.viewer ? [connection.viewer] : [],
      });
      setRoomId(created.roomId);
      setDraft("");
      setSheet(undefined);
      connection.session.channels.refreshList?.();
    } catch (error) {
      setOperationError(
        error instanceof Error
          ? error.message
          : "We couldn’t create the live room. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const renameRoom = async () => {
    const name = renameDraft.trim();
    if (!room || !name || busy) return;
    setBusy(true);
    setOperationError("");
    try {
      await renameLiveRoom(connection, room.id, name);
      setOptimisticRoom({ ...room, name: `${LIVE_ROOM_PREFIX}${name}` });
      setSheet(undefined);
      connection.session.channels.refreshList?.();
    } catch (error) {
      setOperationError(
        error instanceof Error
          ? error.message
          : "We couldn’t rename the live room. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const deleteRoom = async () => {
    if (!room || busy) return;
    setBusy(true);
    setOperationError("");
    try {
      checkOut();
      await deleteLiveRoom(connection, room.id);
      setSheet(undefined);
      setOptimisticRoom(undefined);
      setDeletedRoomIds((ids) => new Set(ids).add(room.id));
      setRoomId(rooms.find(({ id }) => id !== room.id)?.id ?? "");
      connection.session.channels.refreshList?.();
    } catch (error) {
      setOperationError(
        error instanceof Error
          ? error.message
          : "We couldn’t delete the live room. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const invite = async (pubkey: string) => {
    if (!room || busy) return;
    setBusy(true);
    setOperationError("");
    try {
      await inviteToLiveRoom(connection, room.id, pubkey);
      setSheet(undefined);
      connection.session.channels.refreshList?.();
    } catch (error) {
      setOperationError(
        error instanceof Error
          ? error.message
          : "We couldn’t add this member. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!room) {
    return (
      <div className={styles.emptyRooms}>
        <span className={styles.emptyRoomMark}>
          <Radio size={22} aria-hidden="true" />
        </span>
        <h2>No live rooms yet</h2>
        <p>
          Make a private space to work alongside your teammates—and talk when
          you want.
        </p>
        <button
          type="button"
          disabled={connection.status !== "ready"}
          onClick={() => {
            setSheet("create");
            setOperationError("");
          }}
        >
          <Plus size={17} aria-hidden="true" />
          Create live room
        </button>
        {operationError && (
          <p className={styles.operationError} role="alert">
            {operationError}
          </p>
        )}
        {sheet === "create" && (
          <RoomSheet
            value={draft}
            busy={busy}
            onChange={setDraft}
            onClose={() => setSheet(undefined)}
            onSubmit={createRoom}
          />
        )}
      </div>
    );
  }

  const connected = audio?.status === "connected";
  const peers = audio?.peers ?? [];
  const hereKeys = [
    ...(checkedIn && connection.viewer ? [connection.viewer] : []),
    ...peers.map((peer) => peer.pubkey),
  ].filter((pubkey, index, all) => all.indexOf(pubkey) === index);
  const memberKeys = (room.members ?? []).filter(
    (pubkey) => !hereKeys.includes(pubkey),
  );
  const memberCount = room.members?.length ?? 1;
  const ownStatus = !checkedIn
    ? "not-here"
    : audio?.status === "connecting"
      ? "connecting"
      : connected
        ? audio.muted
          ? "listening"
          : audio.micLevel > 0.025
            ? "talking"
            : "mic-on"
        : "around";
  return (
    <div className={styles.root}>
      <div className={styles.roomHeading}>
        <button
          type="button"
          className={styles.roomSwitcher}
          aria-expanded={switching}
          onClick={() => {
            setSwitching((open) => !open);
            setOptionsOpen(false);
          }}
        >
          <span className={styles.roomMark} aria-hidden="true">
            <Radio size={17} />
          </span>
          <span>
            <strong>{displayName(room)}</strong>
            <small>
              {connected
                ? `${hereKeys.length} here now`
                : memberCountLabel(memberCount)}
            </small>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Room settings"
          aria-expanded={optionsOpen}
          onClick={() => {
            setOptionsOpen((open) => !open);
            setSwitching(false);
          }}
        >
          <Settings size={18} aria-hidden="true" />
        </button>
      </div>

      {switching && (
        <div
          className={styles.popover}
          role="menu"
          aria-label="Switch live rooms"
        >
          {rooms.map((candidate) => (
            <button
              type="button"
              key={candidate.id}
              aria-current={candidate.id === room.id ? "true" : undefined}
              onClick={() => selectRoom(candidate.id)}
            >
              <span className={styles.roomOptionLabel}>
                {displayName(candidate)}
                {newRoomIds.has(candidate.id) && (
                  <i className={styles.newRoomBadge}>New</i>
                )}
              </span>
              <small>{memberCountLabel(candidate.members?.length ?? 1)}</small>
            </button>
          ))}
          <button
            type="button"
            className={styles.menuAction}
            onClick={() => {
              setSheet("create");
              setSwitching(false);
            }}
          >
            <Plus size={16} aria-hidden="true" />
            Create live room
          </button>
        </div>
      )}

      {optionsOpen && (
        <div
          className={`${styles.popover} ${styles.optionsMenu}`}
          role="menu"
          aria-label="Room settings"
        >
          <button
            type="button"
            onClick={() => {
              setRenameDraft(displayName(room));
              setSheet("rename");
              setOptionsOpen(false);
              setOperationError("");
            }}
          >
            <Pencil size={16} aria-hidden="true" /> Rename room
          </button>
          <button
            type="button"
            className={styles.dangerAction}
            onClick={() => {
              setSheet("delete");
              setOptionsOpen(false);
            }}
          >
            <Trash2 size={16} aria-hidden="true" /> Delete room
          </button>
        </div>
      )}

      <div className={styles.peopleSections}>
        <PeopleGroup
          title="Here now"
          empty="No one’s here right now"
          pubkeys={hereKeys}
          profiles={profiles}
          viewer={connection.viewer}
          detail={(pubkey) => {
            const peer = peers.find((candidate) => candidate.pubkey === pubkey);
            if (!peer) return "Around";
            if (pubkey === connection.viewer && !audio?.muted) return "Mic on";
            return peer.level > 0.025 ? "Talking" : "Listening";
          }}
          levels={new Map(peers.map((peer) => [peer.pubkey, peer.level]))}
          statusDots
        />
        <PeopleGroup
          title="Room members"
          empty="No other members yet"
          pubkeys={memberKeys}
          profiles={profiles}
          viewer={connection.viewer}
          headingAction={
            <button
              type="button"
              className={styles.sectionHeadingAction}
              aria-label="Add members"
              title="Add members"
              onClick={() => {
                setSheet("invite");
                setOperationError("");
              }}
            >
              <UserPlus size={18} aria-hidden="true" />
            </button>
          }
        />
      </div>

      <section
        className={styles.presenceDock}
        aria-label="Your presence and audio"
      >
        <div className={styles.presenceStatus}>
          <PresenceIndicator status={ownStatus} />
          <div>
            <strong>
              {!checkedIn
                ? "Working here today?"
                : audio?.status === "connecting"
                  ? "Connecting…"
                  : connected
                    ? audio?.muted
                      ? "You’re listening"
                      : "Your mic is on"
                    : "You’re checked in"}
            </strong>
            <small>
              {!checkedIn
                ? "Check in to let members know you’re around"
                : audio?.status === "connecting"
                  ? "Getting room audio ready"
                  : connected
                    ? audio?.muted
                      ? "Turn on the mic to talk"
                      : "Members can hear you"
                    : "Members can see that you’re around"}
            </small>
          </div>
        </div>

        {!checkedIn ? (
          <button
            type="button"
            className={styles.checkInButton}
            onClick={() => setCheckedIn(true)}
          >
            Check in
          </button>
        ) : audio ? (
          <div className={styles.audioActions}>
            <button
              type="button"
              className={audio.muted ? styles.audioControl : styles.liveControl}
              aria-label={audio.muted ? "Turn mic on" : "Turn mic off"}
              aria-pressed={!audio.muted}
              disabled={!connected}
              onClick={() => audioSession.current?.setMuted(!audio.muted)}
            >
              {audio.muted ? (
                <MicOff size={19} aria-hidden="true" />
              ) : (
                <span className={styles.liveMic} aria-hidden="true">
                  <Mic size={18} />
                  <span
                    className={styles.levelBars}
                    style={{
                      transform: `scaleY(${Math.max(0.2, audio.micLevel)})`,
                    }}
                  >
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
              )}
            </button>
            <button
              type="button"
              className={styles.audioExitButton}
              disabled={!connected}
              onClick={leaveAudio}
            >
              Turn off audio
            </button>
            <button
              type="button"
              className={styles.checkOutButton}
              onClick={checkOut}
            >
              Check out
            </button>
          </div>
        ) : (
          <div className={styles.checkedInActions}>
            <button
              type="button"
              className={styles.listenButton}
              disabled={connection.status !== "ready"}
              onClick={() => void joinAudio()}
            >
              <Headphones size={17} aria-hidden="true" /> Listen in
            </button>
            <button
              type="button"
              className={styles.checkOutButton}
              onClick={checkOut}
            >
              Check out
            </button>
          </div>
        )}
      </section>

      {roomNotice && (
        <div className={styles.roomNotice} role="status">
          <span className={styles.roomNoticeMessage}>
            You were added to <strong>{displayName(roomNotice)}</strong>
          </span>
          <button
            type="button"
            className={styles.roomNoticeAction}
            onClick={() => selectRoom(roomNotice.id)}
          >
            View room
          </button>
          <button
            type="button"
            className={styles.noticeDismiss}
            aria-label="Dismiss"
            onClick={() => setRoomNotice(undefined)}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {(operationError || audio?.error) && (
        <p className={styles.operationError} role="alert">
          {operationError || audio?.error}
        </p>
      )}
      {sheet === "create" && (
        <RoomSheet
          value={draft}
          busy={busy}
          onChange={setDraft}
          onClose={() => setSheet(undefined)}
          onSubmit={createRoom}
        />
      )}
      {sheet === "invite" && (
        <InviteSheet
          connection={connection}
          invited={room.members ?? []}
          busy={busy}
          onClose={() => setSheet(undefined)}
          onSelect={(pubkey) => void invite(pubkey)}
        />
      )}
      {sheet === "rename" && (
        <ManagementSheet
          title="Rename room"
          onClose={() => setSheet(undefined)}
          centered
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void renameRoom();
            }}
          >
            <label>
              Room name
              <input
                required
                maxLength={80}
                value={renameDraft}
                onChange={(event) => {
                  setRenameDraft(event.target.value);
                  setOperationError("");
                }}
              />
            </label>
            {operationError && (
              <p className={styles.operationError} role="alert">
                {operationError}
              </p>
            )}
            <button
              type="submit"
              className={styles.sheetPrimary}
              disabled={busy || !renameDraft.trim()}
            >
              {busy ? "Saving…" : "Save name"}
            </button>
          </form>
        </ManagementSheet>
      )}
      {sheet === "delete" && (
        <ManagementSheet
          title={`Delete ${displayName(room)}?`}
          onClose={() => setSheet(undefined)}
        >
          <p className={styles.sheetNote}>
            This permanently removes the live room for everyone and can’t be
            undone.
          </p>
          {operationError && (
            <p className={styles.operationError} role="alert">
              {operationError}
            </p>
          )}
          <button
            type="button"
            className={`${styles.sheetPrimary} ${styles.dangerAction}`}
            disabled={busy}
            onClick={() => void deleteRoom()}
          >
            {busy ? "Deleting…" : "Delete live room"}
          </button>
        </ManagementSheet>
      )}
    </div>
  );
}

function PresenceIndicator({ status }: { status: string }) {
  return (
    <i
      className={styles.presenceIndicator}
      data-status={status}
      aria-hidden="true"
    />
  );
}

function PeopleGroup({
  title,
  empty,
  pubkeys,
  profiles,
  viewer,
  detail,
  headingAction,
  levels = new Map(),
  statusDots = false,
}: {
  title: string;
  empty: string;
  pubkeys: readonly string[];
  profiles: ReadonlyMap<string, Profile>;
  viewer: string | undefined;
  detail?(pubkey: string): string;
  headingAction?: React.ReactNode;
  levels?: ReadonlyMap<string, number>;
  statusDots?: boolean;
}) {
  return (
    <section className={styles.peopleSection}>
      <div className={styles.sectionHeading}>
        <h3>{title}</h3>
        <span>{pubkeys.length}</span>
        {headingAction}
      </div>
      {pubkeys.length ? (
        <ul className={styles.participants}>
          {pubkeys.map((pubkey) => {
            const name =
              pubkey === viewer
                ? "You"
                : (profiles.get(pubkey)?.name ?? pubkey.slice(0, 12));
            const level = levels.get(pubkey);
            const status = detail?.(pubkey);
            return (
              <li key={pubkey}>
                <Avatar name={name} className="size-8 rounded-lg text-xs" />
                <span className={styles.participantInfo}>
                  <strong>{name}</strong>
                  {status && (
                    <small className={styles.personStatus}>
                      {statusDots && (
                        <PresenceIndicator
                          status={status.toLowerCase().replace(" ", "-")}
                        />
                      )}
                      {status}
                    </small>
                  )}
                </span>
                {level !== undefined && (
                  <i
                    className={styles.speakerLevel}
                    style={{ transform: `scaleX(${Math.max(0.04, level)})` }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={styles.emptyPeople}>
          <p>{empty}</p>
        </div>
      )}
    </section>
  );
}

function InviteSheet({
  connection,
  invited,
  busy,
  onClose,
  onSelect,
}: {
  connection: ReturnType<RelayData["snapshot"]>;
  invited: readonly string[];
  busy: boolean;
  onClose(): void;
  onSelect(pubkey: string): void;
}) {
  const [query, setQuery] = useState("@");
  const [error, setError] = useState("");
  const list = useSyncExternalStore(
    connection.session.channels.subscribeList,
    connection.session.channels.list,
    connection.session.channels.list,
  );
  const profiles = useSyncExternalStore(
    connection.session.profiles.subscribe,
    connection.session.profiles.snapshot,
    connection.session.profiles.snapshot,
  );
  const library = useSyncExternalStore(
    connection.session.agentLibrary.subscribe,
    connection.session.agentLibrary.snapshot,
    connection.session.agentLibrary.snapshot,
  );
  const agentKeys = useMemo(
    () => new Set(library.identities.map((identity) => identity.pubkey)),
    [library],
  );
  const humanKeys = useMemo(
    () =>
      [
        ...new Set(list.channels.flatMap((channel) => channel.members ?? [])),
      ].filter(
        (pubkey) => pubkey !== connection.viewer && !agentKeys.has(pubkey),
      ),
    [agentKeys, connection.viewer, list.channels],
  );
  useEffect(() => {
    connection.session.channels.ensureList();
    void connection.session.agentLibrary.refresh();
  }, [connection.session]);
  useEffect(() => {
    if (humanKeys.length)
      void connection.session.profiles.ensure(humanKeys, "background");
  }, [connection.session, humanKeys]);
  const needle = query.startsWith("@")
    ? query.slice(1).trim().toLowerCase()
    : "";
  const suggestions = query.startsWith("@")
    ? humanKeys
        .map((pubkey) => ({
          pubkey,
          name: profiles.get(pubkey)?.name ?? pubkey.slice(0, 12),
        }))
        .filter(
          ({ pubkey, name }) =>
            !invited.includes(pubkey) &&
            `${name} ${pubkey}`.toLowerCase().includes(needle),
        )
        .slice(0, 20)
    : [];
  const submitNpub = () => {
    setError("");
    try {
      const decoded = nip19.decode(query.trim());
      if (decoded.type !== "npub" || typeof decoded.data !== "string")
        throw new Error("Paste a full npub to continue");
      if (decoded.data === connection.viewer || invited.includes(decoded.data))
        throw new Error("This person is already in the live room");
      if (agentKeys.has(decoded.data))
        throw new Error("Live rooms are for people, so agents can’t join");
      onSelect(decoded.data);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Paste a full npub to continue",
      );
    }
  };
  return (
    <ManagementSheet title="Add members" onClose={onClose}>
      <p className={styles.sheetNote}>
        Search for members or paste their npub.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (query.startsWith("npub")) submitNpub();
        }}
      >
        <label>
          Name
          <input
            required
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="@member or npub1…"
            onChange={(event) => {
              setQuery(event.target.value);
              setError("");
            }}
          />
        </label>
        {error && (
          <p className={styles.inviteError} role="alert">
            {error}
          </p>
        )}
        {query.startsWith("@") && (
          <div
            className={styles.identityChoices}
            role="listbox"
            aria-label="Teammate suggestions"
          >
            {suggestions.map((recipient) => (
              <button
                type="button"
                role="option"
                aria-selected="false"
                className={styles.identityChoice}
                disabled={busy}
                key={recipient.pubkey}
                onClick={() => onSelect(recipient.pubkey)}
              >
                <Avatar
                  name={recipient.name}
                  className="size-8 rounded-lg text-xs"
                />
                <span className={styles.identityChoiceLabel}>
                  <strong>{recipient.name}</strong>
                  <code>{nip19.npubEncode(recipient.pubkey)}</code>
                </span>
              </button>
            ))}
            {list.status === "ready" && !suggestions.length && (
              <p>No matching teammates found.</p>
            )}
          </div>
        )}
        {query.startsWith("npub") && (
          <button type="submit" className={styles.sheetPrimary} disabled={busy}>
            {busy ? "Adding…" : "Add member"}
          </button>
        )}
      </form>
    </ManagementSheet>
  );
}

function RoomSheet({
  value,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  value: string;
  busy: boolean;
  onChange(value: string): void;
  onClose(): void;
  onSubmit(): void;
}) {
  return (
    <ManagementSheet title="Create a live room" onClose={onClose} centered>
      <p className={styles.sheetNote}>You can add members once it’s ready.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label>
          Room name
          <input
            required
            maxLength={80}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <button type="submit" className={styles.sheetPrimary} disabled={busy}>
          {busy ? "Creating…" : "Create live room"}
        </button>
      </form>
    </ManagementSheet>
  );
}

function ManagementSheet({
  title,
  children,
  onClose,
  centered = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose(): void;
  centered?: boolean;
}) {
  return (
    <div className={styles.sheetBackdrop}>
      <section
        className={`${styles.sheet} ${centered ? styles.sheetCentered : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
