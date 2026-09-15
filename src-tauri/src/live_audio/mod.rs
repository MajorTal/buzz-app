mod jitter;
mod wire;

use futures_util::{SinkExt, StreamExt};
use jitter::{PeerJitterBuffer, FRAME_SAMPLES, SAMPLE_RATE_HZ};
use serde::Serialize;
use std::{
    collections::HashMap,
    num::{NonZeroU16, NonZeroU32},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use tokio_util::sync::CancellationToken;
use wire::{audio_level_dbov, parse_relay_frame, FrameHeader, FLAG_DTX, PROTOCOL_VERSION};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_SETUP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CHALLENGE_BYTES: usize = 512;
const PCM_FRAME_BYTES: usize = FRAME_SAMPLES * size_of::<f32>();
const LIVE_AUDIO_EVENT: &str = "live-audio-state";

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone, Default)]
pub struct LiveAudioRegistry(Arc<Mutex<Registry>>);

#[derive(Default)]
struct Registry {
    next_generation: u64,
    slot: Option<Slot>,
}

enum Slot {
    Preparing(u64),
    Pending(Box<PendingSession>),
    Active(ActiveSession),
}

struct PendingSession {
    generation: u64,
    relay_tag: String,
    parent_room_id: String,
    challenge: String,
    socket: WsStream,
}

struct ActiveSession {
    generation: u64,
    pcm_tx: mpsc::Sender<Vec<u8>>,
    control_tx: mpsc::Sender<Control>,
    cancel: CancellationToken,
}

enum Control {
    OutputMuted(bool),
    Leave,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAudioSession {
    generation: u64,
    challenge: String,
}

#[derive(Clone, Serialize)]
struct PeerState {
    pubkey: String,
    level: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioState {
    generation: u64,
    status: &'static str,
    peers: Vec<PeerState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn lock_registry(
    registry: &LiveAudioRegistry,
) -> Result<std::sync::MutexGuard<'_, Registry>, String> {
    registry
        .0
        .lock()
        .map_err(|_| "Live audio registry is unavailable".to_string())
}

fn valid_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn audio_socket_url(relay_url: &str, room_id: &str) -> Result<(String, String), String> {
    uuid::Uuid::parse_str(room_id).map_err(|_| "Invalid Live room identifier".to_string())?;
    let mut url = url::Url::parse(relay_url).map_err(|_| "Invalid Buzz relay URL".to_string())?;
    let ws_scheme = match url.scheme() {
        "https" => "wss",
        "http" if matches!(url.host_str(), Some("localhost" | "127.0.0.1")) => "ws",
        "wss" => "wss",
        "ws" if matches!(url.host_str(), Some("localhost" | "127.0.0.1")) => "ws",
        _ => return Err("Live audio requires a secure Buzz relay".to_string()),
    };
    url.set_scheme(ws_scheme)
        .map_err(|_| "Invalid Buzz relay scheme".to_string())?;
    url.set_query(None);
    url.set_fragment(None);
    url.set_path("");
    let relay_tag = url.as_str().trim_end_matches('/').to_string();
    url.set_path(&format!("/huddle/{room_id}/audio"));
    Ok((url.to_string(), relay_tag))
}

fn parse_challenge(text: &str) -> Result<Option<String>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "Invalid audio challenge response".to_string())?;
    if value["type"] != "challenge" {
        return Ok(None);
    }
    let challenge = value["challenge"]
        .as_str()
        .ok_or_else(|| "Audio challenge was missing".to_string())?;
    if challenge.is_empty()
        || challenge.len() > MAX_CHALLENGE_BYTES
        || !challenge.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err("Audio challenge was invalid".to_string());
    }
    Ok(Some(challenge.to_string()))
}

fn validate_auth_event(
    event: &serde_json::Value,
    relay_tag: &str,
    challenge: &str,
) -> Result<(), String> {
    if event["kind"].as_u64() != Some(22_242)
        || event["content"].as_str() != Some("")
        || !event["pubkey"]
            .as_str()
            .is_some_and(|value| valid_hex(value, 32))
        || !event["id"]
            .as_str()
            .is_some_and(|value| valid_hex(value, 32))
        || !event["sig"]
            .as_str()
            .is_some_and(|value| valid_hex(value, 64))
    {
        return Err("The broker returned an invalid audio AUTH event".to_string());
    }
    let tags = event["tags"]
        .as_array()
        .ok_or_else(|| "The broker returned invalid audio AUTH tags".to_string())?;
    let exact_tag = |name: &str, expected: &str| {
        tags.iter().any(|tag| {
            tag.as_array().is_some_and(|items| {
                items.len() == 2
                    && items[0].as_str() == Some(name)
                    && items[1].as_str() == Some(expected)
            })
        })
    };
    if tags.len() != 2 || !exact_tag("relay", relay_tag) || !exact_tag("challenge", challenge) {
        return Err("The broker returned audio AUTH tags for another session".to_string());
    }
    Ok(())
}

fn clear_generation(registry: &LiveAudioRegistry, generation: u64) {
    if let Ok(mut state) = registry.0.lock() {
        let matches = match state.slot.as_ref() {
            Some(Slot::Preparing(current)) => *current == generation,
            Some(Slot::Pending(current)) => current.generation == generation,
            Some(Slot::Active(current)) => current.generation == generation,
            None => false,
        };
        if matches {
            state.slot = None;
        }
    }
}

#[tauri::command]
pub async fn live_audio_prepare(
    relay_url: String,
    room_id: String,
    parent_room_id: String,
    registry: tauri::State<'_, LiveAudioRegistry>,
) -> Result<PreparedAudioSession, String> {
    uuid::Uuid::parse_str(&parent_room_id)
        .map_err(|_| "Invalid parent Live room identifier".to_string())?;
    let (socket_url, relay_tag) = audio_socket_url(&relay_url, &room_id)?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let generation = {
        let mut state = lock_registry(&registry)?;
        // The browser can lose a pending generation during a failed handshake,
        // reload, or hot update. A new explicit join owns the single native slot
        // and fences the abandoned task with a fresh generation.
        if let Some(Slot::Active(active)) = state.slot.take() {
            active.cancel.cancel();
            let _ = active.control_tx.try_send(Control::Leave);
        }
        state.next_generation = state.next_generation.wrapping_add(1).max(1);
        let generation = state.next_generation;
        state.slot = Some(Slot::Preparing(generation));
        generation
    };

    let result = async {
        let (mut socket, _) = tokio::time::timeout(HANDSHAKE_TIMEOUT, connect_async(&socket_url))
            .await
            .map_err(|_| "Live audio relay connection timed out".to_string())?
            .map_err(|error| format!("Live audio relay connection failed: {error}"))?;
        let challenge = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            loop {
                match socket.next().await {
                    Some(Ok(WsMessage::Text(text))) => {
                        if let Some(challenge) = parse_challenge(&text)? {
                            return Ok(challenge);
                        }
                    }
                    Some(Ok(WsMessage::Ping(bytes))) => {
                        socket
                            .send(WsMessage::Pong(bytes))
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                    Some(Ok(WsMessage::Close(_))) | None => {
                        return Err("Live audio relay closed before AUTH".to_string())
                    }
                    Some(Err(error)) => return Err(format!("Live audio relay failed: {error}")),
                    Some(Ok(_)) => {}
                }
            }
        })
        .await
        .map_err(|_| "Live audio challenge timed out".to_string())??;
        Ok::<_, String>((socket, challenge))
    }
    .await;

    match result {
        Ok((socket, challenge)) => {
            let mut state = lock_registry(&registry)?;
            if !matches!(state.slot, Some(Slot::Preparing(current)) if current == generation) {
                return Err("Live audio join was cancelled".to_string());
            }
            state.slot = Some(Slot::Pending(Box::new(PendingSession {
                generation,
                relay_tag,
                parent_room_id,
                challenge: challenge.clone(),
                socket,
            })));
            Ok(PreparedAudioSession {
                generation,
                challenge,
            })
        }
        Err(error) => {
            clear_generation(&registry, generation);
            Err(error)
        }
    }
}

fn parse_peer(value: &serde_json::Value) -> Option<(u8, String, u8)> {
    let index = u8::try_from(value["peer_index"].as_u64()?).ok()?;
    let pubkey = value["pubkey"].as_str()?;
    valid_hex(pubkey, 32).then(|| {
        (
            index,
            pubkey.to_string(),
            value["epoch"]
                .as_u64()
                .and_then(|epoch| u8::try_from(epoch).ok())
                .unwrap_or(0),
        )
    })
}

fn parse_roster(value: &serde_json::Value) -> Vec<(u8, String, u8)> {
    value["peers"]
        .as_array()
        .map(|peers| peers.iter().filter_map(parse_peer).collect())
        .unwrap_or_default()
}

async fn await_joined(socket: &mut WsStream) -> Result<Vec<(u8, String, u8)>, String> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        loop {
            match socket.next().await {
                Some(Ok(WsMessage::Text(text))) => {
                    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                    match value["type"].as_str() {
                        Some("joined") => return Ok(parse_roster(&value)),
                        Some("error") => {
                            return Err(value["message"]
                                .as_str()
                                .unwrap_or("Live audio AUTH was rejected")
                                .to_string())
                        }
                        _ => {}
                    }
                }
                Some(Ok(WsMessage::Ping(bytes))) => socket
                    .send(WsMessage::Pong(bytes))
                    .await
                    .map_err(|error| error.to_string())?,
                Some(Ok(WsMessage::Close(_))) | None => {
                    return Err("Live audio relay closed before joining".to_string())
                }
                Some(Err(error)) => return Err(format!("Live audio relay failed: {error}")),
                Some(Ok(_)) => {}
            }
        }
    })
    .await
    .map_err(|_| "Live audio AUTH timed out".to_string())?
}

fn open_output() -> Result<rodio::MixerDeviceSink, String> {
    rodio::DeviceSinkBuilder::open_default_sink()
        .map_err(|error| format!("Live audio output unavailable: {error}"))
}

#[tauri::command]
pub async fn live_audio_authenticate(
    generation: u64,
    auth_event: serde_json::Value,
    app: tauri::AppHandle,
    registry: tauri::State<'_, LiveAudioRegistry>,
) -> Result<NativeAudioState, String> {
    let pending = {
        let mut state = lock_registry(&registry)?;
        let slot = state.slot.take();
        match slot {
            Some(Slot::Pending(pending)) if pending.generation == generation => *pending,
            other => {
                state.slot = other;
                return Err("This Live audio challenge has expired".to_string());
            }
        }
    };
    if let Err(error) = validate_auth_event(&auth_event, &pending.relay_tag, &pending.challenge) {
        clear_generation(&registry, generation);
        return Err(error);
    }

    let mut socket = pending.socket;
    let auth = serde_json::json!({
        "type": "auth",
        "event": auth_event,
        "parent_channel_id": pending.parent_room_id,
        "protocol_version": PROTOCOL_VERSION,
    });
    if let Err(error) = socket.send(WsMessage::Text(auth.to_string().into())).await {
        clear_generation(&registry, generation);
        return Err(format!("Live audio AUTH send failed: {error}"));
    }
    let roster = match await_joined(&mut socket).await {
        Ok(roster) => roster,
        Err(error) => {
            clear_generation(&registry, generation);
            return Err(error);
        }
    };
    let sink = match tokio::time::timeout(
        OUTPUT_SETUP_TIMEOUT,
        tauri::async_runtime::spawn_blocking(open_output),
    )
    .await
    {
        Ok(Ok(Ok(sink))) => sink,
        Ok(Ok(Err(error))) => {
            clear_generation(&registry, generation);
            return Err(error);
        }
        Ok(Err(error)) => {
            clear_generation(&registry, generation);
            return Err(format!("Live audio output setup failed: {error}"));
        }
        Err(_) => {
            clear_generation(&registry, generation);
            return Err("Live audio output setup timed out".to_string());
        }
    };

    let cancel = CancellationToken::new();
    let (pcm_tx, pcm_rx) = mpsc::channel(50);
    let (control_tx, control_rx) = mpsc::channel(8);
    {
        let mut state = lock_registry(&registry)?;
        if state.slot.is_some() {
            return Err("Another Live audio session started".to_string());
        }
        state.slot = Some(Slot::Active(ActiveSession {
            generation,
            pcm_tx,
            control_tx,
            cancel: cancel.clone(),
        }));
    }

    let initial = state_from_roster(generation, "connected", &roster, &HashMap::new(), None);
    let registry_for_task = registry.inner().clone();
    let initial_for_task = roster;
    tauri::async_runtime::spawn(async move {
        let result = run_audio_session(
            generation,
            socket,
            sink,
            initial_for_task,
            pcm_rx,
            control_rx,
            cancel.clone(),
            app.clone(),
        )
        .await;
        clear_generation(&registry_for_task, generation);
        if let Err(error) = result {
            let _ = app.emit(
                LIVE_AUDIO_EVENT,
                NativeAudioState {
                    generation,
                    status: "error",
                    peers: Vec::new(),
                    error: Some(error),
                },
            );
        }
    });
    Ok(initial)
}

fn state_from_roster(
    generation: u64,
    status: &'static str,
    roster: &[(u8, String, u8)],
    levels: &HashMap<u8, f32>,
    error: Option<String>,
) -> NativeAudioState {
    NativeAudioState {
        generation,
        status,
        peers: roster
            .iter()
            .map(|(index, pubkey, _)| PeerState {
                pubkey: pubkey.clone(),
                level: levels.get(index).copied().unwrap_or(0.0),
            })
            .collect(),
        error,
    }
}

struct PeerSlot {
    epoch: u8,
    pubkey: String,
    jitter: PeerJitterBuffer,
    player: rodio::Player,
    last_packet: tokio::time::Instant,
    recovering: bool,
}

impl PeerSlot {
    fn new(
        index: u8,
        epoch: u8,
        pubkey: String,
        mixer: &rodio::mixer::Mixer,
        output_muted: bool,
    ) -> Result<Self, String> {
        let player = rodio::Player::connect_new(mixer);
        player.set_volume(if output_muted { 0.0 } else { 1.0 });
        Ok(Self {
            epoch,
            pubkey,
            jitter: PeerJitterBuffer::new(index).map_err(|error| error.to_string())?,
            player,
            last_packet: tokio::time::Instant::now(),
            recovering: false,
        })
    }

    fn active(&self) -> bool {
        self.last_packet.elapsed() < Duration::from_millis(500) || !self.jitter.is_empty()
    }

    fn recover_clock_drift(&mut self) {
        let recover = if self.recovering {
            self.player.len() > 4
        } else {
            self.player.len() >= 10
        };
        if recover != self.recovering {
            self.recovering = recover;
            self.player.set_speed(if recover { 1.02 } else { 1.0 });
        }
        if self.player.len() >= 30 {
            self.player.skip_one();
        }
    }
}

fn replace_roster(
    roster: &mut Vec<(u8, String, u8)>,
    peers: &mut HashMap<u8, PeerSlot>,
    replacement: Vec<(u8, String, u8)>,
) {
    let identities: HashMap<u8, (&str, u8)> = replacement
        .iter()
        .map(|(index, pubkey, epoch)| (*index, (pubkey.as_str(), *epoch)))
        .collect();
    peers.retain(|index, slot| {
        identities
            .get(index)
            .is_some_and(|(pubkey, epoch)| *pubkey == slot.pubkey && *epoch == slot.epoch)
    });
    *roster = replacement;
}

#[allow(clippy::too_many_arguments)]
async fn run_audio_session(
    generation: u64,
    socket: WsStream,
    sink: rodio::MixerDeviceSink,
    mut roster: Vec<(u8, String, u8)>,
    mut pcm_rx: mpsc::Receiver<Vec<u8>>,
    mut control_rx: mpsc::Receiver<Control>,
    cancel: CancellationToken,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use rodio::buffer::SamplesBuffer;

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut encoder = opus::Encoder::new(
        SAMPLE_RATE_HZ,
        opus::Channels::Mono,
        opus::Application::Voip,
    )
    .map_err(|error| format!("Live audio Opus encoder failed: {error}"))?;
    encoder
        .set_bitrate(opus::Bitrate::Bits(32_000))
        .map_err(|error| format!("Live audio Opus bitrate failed: {error}"))?;
    encoder
        .set_dtx(true)
        .map_err(|error| format!("Live audio Opus DTX failed: {error}"))?;
    let mut encoded = vec![0_u8; 4_000];
    let mut sequence = 0_u16;
    let mut timestamp = 0_u32;
    let mut peers = HashMap::<u8, PeerSlot>::new();
    let mut levels = HashMap::<u8, f32>::new();
    let mut output_muted = false;
    let mut playout_tick = tokio::time::interval(Duration::from_millis(10));
    playout_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut level_tick = tokio::time::interval(Duration::from_millis(50));
    level_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let channels = NonZeroU16::new(1).expect("one channel");
    let sample_rate = NonZeroU32::new(SAMPLE_RATE_HZ).expect("48 kHz");

    loop {
        tokio::select! {
            biased;
            control = control_rx.recv() => match control {
                Some(Control::OutputMuted(muted)) => {
                    output_muted = muted;
                    for peer in peers.values() {
                        peer.player.set_volume(if muted { 0.0 } else { 1.0 });
                    }
                }
                Some(Control::Leave) | None => {
                    let _ = ws_tx.send(WsMessage::Text("{\"type\":\"leave\"}".into())).await;
                    break;
                }
            },
            _ = cancel.cancelled() => break,
            _ = playout_tick.tick() => {
                for slot in peers.values_mut() {
                    if !slot.active() {
                        let _ = slot.jitter.playout();
                        continue;
                    }
                    if let Ok(samples) = slot.jitter.playout() {
                        slot.recover_clock_drift();
                        slot.player.append(SamplesBuffer::new(channels, sample_rate, samples));
                    }
                }
            }
            _ = level_tick.tick() => {
                let _ = app.emit(
                    LIVE_AUDIO_EVENT,
                    state_from_roster(generation, "connected", &roster, &levels, None),
                );
                for level in levels.values_mut() {
                    *level *= 0.55;
                }
                levels.retain(|_, level| *level > 0.000_1);
            }
            pcm = pcm_rx.recv() => {
                let Some(bytes) = pcm else { break };
                if bytes.len() != PCM_FRAME_BYTES { continue }
                let mut samples = Vec::with_capacity(FRAME_SAMPLES);
                for bytes in bytes.chunks_exact(4) {
                    let sample = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                    samples.push(if sample.is_finite() { sample.clamp(-1.0, 1.0) } else { 0.0 });
                }
                let count = encoder
                    .encode_float(&samples, &mut encoded)
                    .map_err(|error| format!("Live audio Opus encode failed: {error}"))?;
                if count == 0 { continue }
                let header = FrameHeader {
                    seq: sequence,
                    ts_48k: timestamp,
                    level_dbov: audio_level_dbov(&samples),
                    flags: if count <= 2 { FLAG_DTX } else { 0 },
                }.encode();
                let mut frame = Vec::with_capacity(header.len() + count);
                frame.extend(header);
                frame.extend(&encoded[..count]);
                ws_tx.send(WsMessage::Binary(frame.into())).await
                    .map_err(|error| format!("Live audio send failed: {error}"))?;
                sequence = sequence.wrapping_add(1);
                timestamp = timestamp.wrapping_add(FRAME_SAMPLES as u32);
            }
            message = ws_rx.next() => match message {
                Some(Ok(WsMessage::Binary(bytes))) => {
                    let Some((index, header, opus)) = parse_relay_frame(&bytes) else { continue };
                    let Some((_, pubkey, epoch)) = roster.iter().find(|(peer, _, _)| *peer == index).cloned() else { continue };
                    let replace = peers.get(&index).is_some_and(|slot| slot.pubkey != pubkey || slot.epoch != epoch);
                    if replace { peers.remove(&index); }
                    if let std::collections::hash_map::Entry::Vacant(entry) = peers.entry(index) {
                        let slot = PeerSlot::new(index, epoch, pubkey, sink.mixer(), output_muted)?;
                        entry.insert(slot);
                    }
                    if let Some(slot) = peers.get_mut(&index) {
                        if slot.jitter.insert(index, header.seq, header.ts_48k, opus).is_ok() {
                            slot.last_packet = tokio::time::Instant::now();
                        }
                    }
                    let linear = if header.level_dbov <= -127 {
                        0.0
                    } else {
                        10_f32.powf(f32::from(header.level_dbov) / 20.0)
                    };
                    levels.entry(index).and_modify(|level| *level = level.max(linear)).or_insert(linear);
                }
                Some(Ok(WsMessage::Text(text))) => {
                    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                    match value["type"].as_str() {
                        Some("joined" | "roster") if value["peers"].is_array() => {
                            replace_roster(&mut roster, &mut peers, parse_roster(&value));
                        }
                        Some("left") => {
                            if let Some(index) = value["peer_index"].as_u64().and_then(|index| u8::try_from(index).ok()) {
                                roster.retain(|(peer, _, _)| *peer != index);
                                peers.remove(&index);
                                levels.remove(&index);
                            }
                        }
                        Some("error") => return Err(value["message"].as_str().unwrap_or("Live audio relay error").to_string()),
                        _ => {}
                    }
                    let _ = app.emit(
                        LIVE_AUDIO_EVENT,
                        state_from_roster(generation, "connected", &roster, &levels, None),
                    );
                }
                Some(Ok(WsMessage::Ping(bytes))) => {
                    ws_tx.send(WsMessage::Pong(bytes)).await
                        .map_err(|error| format!("Live audio heartbeat failed: {error}"))?;
                }
                Some(Ok(WsMessage::Close(_))) | None => return Err("Live audio relay disconnected".to_string()),
                Some(Err(error)) => return Err(format!("Live audio receive failed: {error}")),
                Some(Ok(_)) => {}
            }
        }
    }
    let _ = ws_tx.send(WsMessage::Close(None)).await;
    Ok(())
}

#[tauri::command]
pub fn live_audio_push_pcm(
    request: tauri::ipc::Request<'_>,
    registry: tauri::State<'_, LiveAudioRegistry>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Live audio expects raw PCM".to_string());
    };
    if bytes.len() != PCM_FRAME_BYTES {
        return Err(format!(
            "Live audio PCM must be exactly {PCM_FRAME_BYTES} bytes"
        ));
    }
    let state = lock_registry(&registry)?;
    let Some(Slot::Active(active)) = state.slot.as_ref() else {
        return Ok(());
    };
    let _ = active.pcm_tx.try_send(bytes.to_vec());
    Ok(())
}

#[tauri::command]
pub fn live_audio_set_output_muted(
    generation: u64,
    muted: bool,
    registry: tauri::State<'_, LiveAudioRegistry>,
) -> Result<(), String> {
    let state = lock_registry(&registry)?;
    let Some(Slot::Active(active)) = state.slot.as_ref() else {
        return Err("Live audio is not connected".to_string());
    };
    if active.generation != generation {
        return Err("This Live audio session has expired".to_string());
    }
    active
        .control_tx
        .try_send(Control::OutputMuted(muted))
        .map_err(|_| "Live audio output control is busy".to_string())
}

#[tauri::command]
pub async fn live_audio_leave(
    generation: u64,
    registry: tauri::State<'_, LiveAudioRegistry>,
) -> Result<(), String> {
    let slot = {
        let mut state = lock_registry(&registry)?;
        let matches = match state.slot.as_ref() {
            Some(Slot::Preparing(current)) => *current == generation,
            Some(Slot::Pending(current)) => current.generation == generation,
            Some(Slot::Active(current)) => current.generation == generation,
            None => false,
        };
        if matches {
            state.slot.take()
        } else {
            None
        }
    };
    match slot {
        Some(Slot::Pending(mut pending)) => {
            let _ = pending.socket.send(WsMessage::Close(None)).await;
        }
        Some(Slot::Active(active)) => {
            let _ = active.control_tx.try_send(Control::Leave);
            active.cancel.cancel();
        }
        Some(Slot::Preparing(_)) | None => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_deployed_huddle_audio_url() {
        let room = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(
            audio_socket_url("https://relay.buzz.xyz/ignored", room).unwrap(),
            (
                format!("wss://relay.buzz.xyz/huddle/{room}/audio"),
                "wss://relay.buzz.xyz".to_string(),
            )
        );
        assert!(audio_socket_url("http://relay.buzz.xyz", room).is_err());
    }

    #[test]
    fn auth_event_is_fixed_to_the_pending_relay_and_challenge() {
        let event = serde_json::json!({
            "id": "a".repeat(64),
            "pubkey": "b".repeat(64),
            "created_at": 1,
            "kind": 22242,
            "tags": [["relay", "wss://relay.buzz.xyz"], ["challenge", "nonce"]],
            "content": "",
            "sig": "c".repeat(128),
        });
        validate_auth_event(&event, "wss://relay.buzz.xyz", "nonce").unwrap();
        assert!(validate_auth_event(&event, "wss://other.buzz.xyz", "nonce").is_err());
        assert!(validate_auth_event(&event, "wss://relay.buzz.xyz", "other").is_err());
    }
}
