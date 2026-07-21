# Path A — Grok voice-mode WebRTC relay (grok-as-agent realtime voice)

Status: **audio bridge foundation SHIPPED + live-proven; browser/WebRTC edge remaining.**

Path A lets the owner talk to **Grok's own voice mode** hands-free through sudo-ai:
a Cloudflare-cleared browser runs grok.com voice mode; we feed the user's audio in
via a fake mic and capture grok's spoken reply out via a PulseAudio null sink.
Unlike Path B (merged: #901/#902/#903/#904, sudo-ai's brain, turn-based), Path A is
**grok-as-agent** — grok's model does the talking — and is realtime WebRTC.

## What is DONE (this PR)

`src/core/voice/pulse-audio.ts` — `PulseAudioSink`: a private PulseAudio server
with a `grokvoice` null sink (the box has no hardware sound — `/dev/snd` = seq/timer
only, so a null sink is the only headless capture path).

- `start()` — spawn the private daemon + null sink on a dedicated `XDG_RUNTIME_DIR`
  (never touches system PulseAudio); idempotent; verifies the sink appeared.
- `captureMonitor(durationMs, outPath)` — **agent OUT**: record `grokvoice.monitor`
  for an exact duration via `ffmpeg -f pulse -t` → mono 24 kHz WAV.
  (NB: `parec` drops its buffered PCM on SIGTERM — writes only the 44-byte header;
  ffmpeg's `-t` self-finalizes. This cost a debugging cycle — do not switch back.)
- `fakeMicPath()` — **agent IN**: where the relay writes the WAV that Chrome reads
  via `--use-file-for-fake-audio-capture`.
- `stop()` — kill the daemon + remove the runtime dir.

Verified: `tests/voice/pulse-audio.test.ts` (6, mocked runner) + a LIVE round-trip
`scripts/grok-voice-relay-audio-check.mts` (tone → sink → monitor capture → RMS
1732, non-silent). Run it: `npx tsx scripts/grok-voice-relay-audio-check.mts`.

## What REMAINS (needs a live grok voice-mode session on a display — unverifiable headless)

The screenshot-banked increments, in order:

1. **Dedicated voice Chrome** — reuse `WarmGrokBrowser` (`src/llm/grok-warm-browser.ts`,
   the GWV6 CF-cleared chromium) but a SEPARATE profile/port from the video warm
   browser (9223), launched with `PULSE_SERVER=unix:<runtimeDir>/pulse/native`,
   default sink = `grokvoice`, and flags
   `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<fakeMicPath> --autoplay-policy=no-user-gesture-required`.
   Navigate to grok voice mode.
2. **Activate voice mode via CDP** — grant mic with `Browser.grantPermissions`
   (origin https://grok.com, permission `audioCapture`); click the voice-mode
   control; **confirm a WebRTC session establishes**. The signaling WS is
   `wss://grok-api.gcp.mouseion.dev/ws/mgw/?uid=<userId>` (userId from
   `GET /rest/auth/get-user`); it works natively in-browser (CF-cleared) but is
   302-refused to any non-browser client — this is why the relay is browser-mandatory.
3. **Bridge the audio** — agent OUT = `captureMonitor` (already done); agent IN =
   rewrite `fakeMicPath()` (or a FIFO) with the user's audio. AEC is out of scope —
   half-duplex or an echo-cancelled fake mic so grok's own voice doesn't loop.
4. **Wrap as an owner-gated, flagged service** — e.g. `SUDO_GROK_VOICE_RELAY`
   (default OFF) + owner gate; declare per-session budgets; kill switch.
5. **Verify one real spoken turn** end-to-end.

References: `project-grok-provider.md` memory (voice-mode endpoint capture, mgw CF
gating, the pulse spike), `src/llm/grok-warm-browser.ts` (CF-cleared browser),
`src/core/voice/voice-session.ts` (the Path B streaming state machine — the relay's
turn/barge-in shape can mirror it).
