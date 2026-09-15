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
  MoreHorizontal,
  Plus,
  Radio,
  UserPlus,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { Avatar } from "../../shared/Avatar";
import { connectLiveAudio } from "./audio";
import type { LiveAudioSession, LiveAudioState } from "./audio";
import { createLiveRoom, inviteToLiveRoom, LIVE_ROOM_PREFIX } from "./api";
import styles from "./RoomsPanel.module.css";

type Sheet = "create" | "invite";

const isLiveRoom = (channel: ChannelSummary) =>
  channel.channelType === "stream" &&
  channel.name.startsWith(LIVE_ROOM_PREFIX) &&
  !channel.archived;

const displayName = (room: ChannelSummary) =>
  room.name.slice(LIVE_ROOM_PREFIX.length);

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
  const rooms = useMemo(
    () => channelList.channels.filter(isLiveRoom),
    [channelList.channels],
  );
  const [roomId, setRoomId] = useState("");
  const [optimisticRoom, setOptimisticRoom] = useState<ChannelSummary>();
  const [switching, setSwitching] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>();
  const [draft, setDraft] = useState("");
  const [operationError, setOperationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState<LiveAudioState>();
  const audioSession = useRef<LiveAudioSession | undefined>(undefined);
  const audioJoinAbort = useRef<AbortController | undefined>(undefined);
  const audioGeneration = useRef(0);
  const audioScope = useRef(connection.scope);
  const room =
    rooms.find((candidate) => candidate.id === roomId) ??
    (optimisticRoom?.id === roomId ? optimisticRoom : undefined) ??
    rooms[0];

  useEffect(
    () => connection.session.channels.ensureList(),
    [connection.session],
  );
  useEffect(() => {
    if (!roomId && rooms[0]) setRoomId(rooms[0].id);
    if (optimisticRoom && rooms.some(({ id }) => id === optimisticRoom.id))
      setOptimisticRoom(undefined);
  }, [optimisticRoom, roomId, rooms]);
  useEffect(() => {
    const pubkeys = audio?.peers.map((peer) => peer.pubkey) ?? [];
    if (pubkeys.length)
      void connection.session.profiles.ensure(pubkeys, "background");
  }, [audio?.peers, connection.session]);
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
  }, [connection.scope]);

  const leaveAudio = () => {
    audioGeneration.current++;
    audioJoinAbort.current?.abort();
    audioJoinAbort.current = undefined;
    audioSession.current?.leave();
    audioSession.current = undefined;
    setAudio(undefined);
  };
  const selectRoom = (id: string) => {
    if (id !== room?.id) leaveAudio();
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
      setOperationError(
        error instanceof Error
          ? error.message
          : "We couldn’t connect you to the live room. Try again.",
      );
    }
  };
  const createRoom = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    setOperationError("");
    try {
      const created = await createLiveRoom(connection, name);
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
          : "We couldn’t send the invite. Try again.",
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
  const memberCount = room.members?.length ?? 1;
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
                ? `${peers.length} here now`
                : `${memberCount} member${memberCount === 1 ? "" : "s"}`}
            </small>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Live room options"
          aria-expanded={optionsOpen}
          onClick={() => {
            setOptionsOpen((open) => !open);
            setSwitching(false);
          }}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
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
              <span>{displayName(candidate)}</span>
              <small>{candidate.members?.length ?? 1} members</small>
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
          aria-label="Live room options"
        >
          <button
            type="button"
            onClick={() => {
              setSheet("invite");
              setOptionsOpen(false);
            }}
          >
            <UserPlus size={16} aria-hidden="true" /> Invite teammate
          </button>
          {audio && (
            <button type="button" onClick={leaveAudio}>
              <Headphones size={16} aria-hidden="true" /> Leave live room
            </button>
          )}
        </div>
      )}

      <section className={styles.presence} aria-label="Live room connection">
        <div>
          <span className={styles.presenceDot} data-present={connected} />
          <div>
            <strong>
              {audio?.status === "connecting"
                ? "Joining…"
                : connected
                  ? "You’re here"
                  : "You’re not here yet"}
            </strong>
            <p>
              {connected
                ? audio.muted
                  ? "You’re listening. Unmute when you want to talk."
                  : "Your mic is on. You’re ready to talk."
                : "Join when you’re ready to listen or talk."}
            </p>
          </div>
        </div>
      </section>

      <section
        className={styles.peopleSection}
        aria-labelledby="room-people-heading"
      >
        <div className={styles.sectionHeading}>
          <h3 id="room-people-heading">Here now</h3>
          <span>{peers.length}</span>
        </div>
        {peers.length ? (
          <ul className={styles.participants}>
            {peers.map((peer) => {
              const profile = profiles.get(peer.pubkey);
              const own = peer.pubkey === connection.viewer;
              const name = own
                ? "You"
                : (profile?.name ?? peer.pubkey.slice(0, 12));
              return (
                <li key={peer.pubkey}>
                  <Avatar name={name} className="size-8 rounded-lg text-xs" />
                  <span className={styles.participantInfo}>
                    <strong>{name}</strong>
                    <small>
                      {peer.level > 0.025 ? "Speaking" : "Listening"}
                    </small>
                  </span>
                  <i
                    className={styles.speakerLevel}
                    style={{
                      transform: `scaleX(${Math.max(0.04, peer.level)})`,
                    }}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <div className={styles.emptyPeople}>
            <p>No one’s here yet.</p>
            <small>Join audio to let others know you’re here.</small>
          </div>
        )}
      </section>

      <div className={styles.audioDock} data-listening={connected}>
        <div className={styles.audioStatus}>
          <span className={styles.audioIcon}>
            <Headphones size={18} aria-hidden="true" />
          </span>
          <div>
            <strong>
              {connected ? "You’re connected" : "Talk when you want"}
            </strong>
            <small>
              {connected
                ? `${peers.length} connected`
                : "You’ll join with your mic off"}
            </small>
          </div>
        </div>
        {audio ? (
          <div className={styles.audioActions}>
            <button
              type="button"
              className={audio.muted ? styles.audioControl : styles.liveControl}
              aria-label={audio.muted ? "Unmute microphone" : "Mute microphone"}
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
              className={
                audio.outputMuted ? styles.audioControl : styles.liveControl
              }
              aria-label={
                audio.outputMuted ? "Unmute speakers" : "Mute speakers"
              }
              aria-pressed={!audio.outputMuted}
              disabled={!connected}
              onClick={() =>
                audioSession.current?.setOutputMuted(!audio.outputMuted)
              }
            >
              {audio.outputMuted ? (
                <VolumeX size={19} aria-hidden="true" />
              ) : (
                <Volume2 size={19} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className={styles.leaveButton}
              onClick={leaveAudio}
            >
              Leave
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={styles.listenButton}
            disabled={connection.status !== "ready"}
            onClick={() => void joinAudio()}
          >
            <Headphones size={17} aria-hidden="true" /> Join audio
          </button>
        )}
      </div>

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
    </div>
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
    <ManagementSheet title="Invite a teammate" onClose={onClose}>
      <p className={styles.sheetNote}>
        Type @ to find a teammate in this community, or paste their npub.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (query.startsWith("npub")) submitNpub();
        }}
      >
        <label>
          Person
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
                <span>
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
            {busy ? "Inviting…" : "Send invite"}
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
      <p className={styles.sheetNote}>
        You can invite teammates once it’s ready.
      </p>
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
