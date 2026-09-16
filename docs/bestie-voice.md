# Bestie realtime voice

Open Bestie from its companion launcher anywhere the app offers the panel, then
click Call at the bottom of the panel. Speak naturally and interrupt a reply by speaking.
The ellipsis menu beside Close contains thinking level and tool approval settings.
During a call, the bottom controls show mute, live microphone activity and hang-up;
Bestie gently nods and tilts in response to its audio playback, changing its lean
after speech pauses and settling when quiet. The microphone
waveform uses monochrome bars and a mirrored layer at 20% opacity. Call controls
fade into a stable footer when starting, with immediate keyboard transitions. Reduced motion keeps
both indicators still while their opacity responds to audio. Transcripts are hidden
by default. Toggle **Show transcript** in the ellipsis menu at any time to reveal
or hide the current conversation using the Messages app’s message rows. When shown,
the space above the call controls splits evenly between Bestie and a separate
transcript scroll area. Messages soften into a subtle blur and fade at its top edge. Hiding
the transcript does not erase it or restart the call. The choice lasts while
Bestie is enabled in this app session. Tool approval requests remain visible.
Closing the panel, changing community/account, disabling Bestie or disconnecting
the relay ends the call. Immediate panel relocation retains the same call.

## Setup

First configure the existing account's public `BUZZ_DEV_VIEWER` pin as described
in [Relay channels](../README.md#relay-channels). Live development currently uses
the macOS Keychain broker. It works in `just web` and `just desktop`; the packaged
native app does not include the broker or an agent host yet.

Build `buzz-agent` and `buzz-dev-mcp` from the realtime implementation in
[Buzz PR 7519](https://github.com/block/buzz/pull/7519). The integration uses
revision `9bab300881db59c8a58ef0e54924dd2d5b4c995f`:

```sh
git clone https://github.com/block/buzz.git buzz-agent-source
cd buzz-agent-source
git checkout 9bab300881db59c8a58ef0e54924dd2d5b4c995f
bin/cargo build --release -p buzz-agent -p buzz-dev-mcp
```

Start your realtime server separately, then add its WebSocket URL to the app's
ignored `.env.local`. Use absolute paths for binaries unless they are on the
development server's PATH:

```dotenv
BUZZ_REALTIME_ENDPOINT=ws://127.0.0.1:18870/v1/realtime
BUZZ_REALTIME_API_KEY=your-endpoint-token
BUZZ_REALTIME_MODEL=realtime
BUZZ_AGENT_BIN=/absolute/path/to/buzz-agent-source/target/release/buzz-agent
BUZZ_MCP_BIN=/absolute/path/to/buzz-agent-source/target/release/buzz-dev-mcp
```

Only the endpoint is required when the binaries are on PATH and the service does
not require authentication. The model defaults to `realtime`; use the provider's
model name where required. Provider URL, token and agent credentials stay in the
host process. Use `wss://` for a remote service, or reach a loopback server through
an SSH tunnel. Open the app on localhost or HTTPS so the browser can use the
microphone. Restart the development server after changing host settings.

The endpoint must implement the OpenAI Realtime WebSocket events used by Buzz:
session configuration, PCM16 input/output at 24 kHz, transcription, response
cancellation/truncation, and function calls with continued responses after tool
results. Compatibility depends on these features; a text-completion URL cannot
serve as the realtime endpoint.

Frankie endpoints can be built from
[llama.cpp PR 1](https://github.com/tlongwell-block/llama.cpp/pull/1) or
[MTPLX PR 1](https://github.com/tlongwell-block/MTPLX/pull/1). Follow their runtime
guides and obtain a compatible model separately. The application contains no
model weights or voice recordings. Model and voice permissions are separate from
this application's software license.
For either Frankie runtime, set `BUZZ_REALTIME_MODEL=frankie` as well as the
endpoint and its access token.

## Tools, identity and community

**Automatically approve** is the default tool policy. Select **Ask each time**
before starting a call to require an Allow once or Deny decision. Both modes use
the agent's ACP permission requests; Buzz executes the tools. End and reconnect
to change the policy or thinking level. Tools execute on the machine running the
development broker, even if inference is remote.

The host creates Bestie's independent Nostr keypair on first use and stores it in
the private `~/.buzz/bestie` directory. It retains that key for the same owner and
issues an owner-signed NIP-OA attestation for each call. The owner private key is
never passed to the agent or browser. The agent receives its own credentials and
the relay captured from the GUI's current community, and uses the real `buzz` CLI
provided by `buzz-dev-mcp`.

Bestie has a separate working directory for each owner/community. It starts a
fresh agent conversation for each call and does not inherit project instructions
or persist the panel transcript. The captured community cannot change under an
active call: switching ends it and clears the previous transcript and approvals.
Only one voice call runs at a time in this development host.

NIP-OA establishes agency; it does not automatically enroll Bestie in private
channels. Ask Bestie to create its profile or join a channel when needed, subject
to relay permissions. It is instructed to prefix published messages with 🤖.
Automatic tool approval does not change the relay's access rules.

## Try it

Select a community, open Bestie and start a call. Ask a short question, interrupt
a longer reply, then ask a follow-up. Mute/unmute, end the call and reconnect.
For a harmless tool check, ask it to run `printf 'hello'` and report the result.
Reconnect with **Ask each time** to exercise Allow once and Deny. Switch to another
community during a call and confirm it ends with the old transcript cleared.

The focused tests cover key persistence and signed owner attestation, host scope
and process cleanup, automatic/manual approval, browser capture/playback, and
panel lifecycle. Browser fixtures use isolated identities and synthetic speech;
they do not publish to a real community. Follow the repository's `just scan`
workflow for the full regression gate.

If another call is still shutting down, wait briefly before starting again. A
failed provider or microphone connection ends the call so it can be restarted.
If a Bluetooth headset makes playback sound muffled, select a separate microphone
or playback device; the client requests mono 24 kHz PCM and uses the browser's
audio output routing.
