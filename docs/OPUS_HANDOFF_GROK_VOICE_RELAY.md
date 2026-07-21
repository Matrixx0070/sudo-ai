# Path A — Grok realtime voice (grok-as-agent), seat-covered via LiveKit

Status: **SHIPPED + live-proven end-to-end.** Realtime voice with grok's own
voice agent, browserless, FREE on the $30 subscription seat.

## The route (all proven live with `data/grok-web-session.json` cookies only)

grok.com voice mode runs on **LiveKit (WebRTC)** — NOT the raw `mgw` WS an earlier
investigation chased, and NOT a browser relay. The seat reaches it directly:

1. `POST grok.com/rest/livekit/tokens` (seat cookies, **statsig-free**, body
   `{"requestAgentDispatch":true}`) → HTTP 200 LiveKit JWT granting
   `roomJoin/canPublish/canSubscribe` for `xai_user_<uuid>/new/<id>`, with
   `roomConfig.agents=[{agentName:"prod"}]` (grok's voice agent auto-dispatches).
2. Connect a LiveKit client to **`wss://livekit.grok.com`** with that token
   (browserless — the `livekit` Python SDK). The "prod" agent joins as a
   participant (kind=4) and publishes an audio track (kind=1).
3. Publish the user's audio (a mic track); subscribe the agent's audio track =
   grok's spoken reply.

Live proof: asked (spoken) "capital of France?" → agent replied "Paris."; asked
"fun fact about octopuses" → "Octopuses have three hearts and blue blood." —
captured over the seat, no browser, no metered `api.x.ai`, `console.x.ai` flat.

## Components (this PR)

- `scripts/grok-web/grok_livekit_voice.py` — one-turn client (stdin JSON
  `{cookie,userAgent,inputWav,outputPath,captureSeconds}` → stdout JSON). Mints
  the seat token, joins, publishes the input WAV, captures the agent reply WAV.
- `src/llm/grok-livekit-bridge.ts` — Node↔Python spawn bridge (secrets on stdin
  only), mirrors `grok-web-bridge.ts`.
- `src/llm/grok-realtime-voice.ts` — `grokRealtimeVoiceTurn(inputWav)`: session
  manager → creds → bridge → reply WAV. Gated by `SUDO_GROK_WEBSESSION`.
- `sudo-ai grok voice <input> [--seconds N --out path]` — CLI (owner).
- Tests: `grok-livekit-bridge` + `grok-realtime-voice` (mocked); the live turn is
  proven by the CLI (not in CI).

## Dependency

New runtime dep: the **`livekit`** Python SDK (`pip install --user --break-system-packages livekit`)
— a prebuilt manylinux wheel with native libwebrtc; runs headless. `ffmpeg` +
`curl_cffi` (already present) are also used. Provision on the prod host.

## Remaining / next

- **Continuous streaming**: V1 is one turn (speak a WAV → capture the reply). A
  streaming session (persistent room, continuous mic in / agent audio out with
  the agent's server-VAD driving turns + barge-in) is the next increment —
  reuse the Path B `VoiceSession` shape; feed it live audio from a channel.
- **Wire a consumer**: Telegram voice note → one `grokRealtimeVoiceTurn` → voice
  reply is the smallest real consumer; or a phone bridge.
- **Own flag**: currently reuses `SUDO_GROK_WEBSESSION`; a dedicated
  `SUDO_GROK_VOICE` + per-session budget/kill-switch is worth adding.
- **Supersedes** the PulseAudio browser-relay approach (that PR should be closed);
  LiveKit connects directly, no browser and no null sink.
