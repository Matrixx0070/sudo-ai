#!/usr/bin/env python3
"""Grok realtime voice — a PERSISTENT streaming session over LiveKit, on the seat.

Unlike grok_livekit_voice.py (one turn, connect-per-turn), this joins the room
ONCE and handles MANY turns over the same connection, so grok's conversation
context persists across turns and there is no per-turn join latency. grok's "prod"
agent does server-side VAD + turn-taking + barge-in natively; we detect the end
of each agent reply with a trailing-silence energy VAD on the received audio.

Protocol: line-delimited JSON on stdin, line-delimited JSON events on stdout.
  stdin:  {"cmd":"speak","wav":"/path/user.wav","out":"/path/reply.wav"}
          {"cmd":"quit"}
  stdout: {"event":"ready","agentIdentity":"agent-..."}
          {"event":"reply","turn":N,"path":"/path/reply.wav","durationMs":M,"bytes":B}
          {"event":"error","errorClass":"...","detail":"..."}
          {"event":"bye"}

Secrets (cookie) arrive on argv[1..2] path to the session file, read locally.
Needs: `livekit`, ffmpeg, curl_cffi. Same-host as the captured session.
"""
import asyncio, json, subprocess, sys, time, wave

GROK = "https://grok.com"
LIVEKIT_URL = "wss://livekit.grok.com"
SR = 48000
FRAME = int(SR * 0.02)             # 20ms
MAX_REPLY_S = 40                    # hard cap per turn
SPEAK_START_TIMEOUT_S = 12         # how long to wait for the agent to begin replying
WIN_BYTES = int(SR * 0.4) * 2      # 400ms trailing window for silence detection
SIL_RMS = 150                      # trailing window below this = silence
HANGOVER_S = 1.0                   # trailing silence that ends the agent reply


def rms(buf: bytes) -> float:
    import array
    a = array.array("h")
    a.frombytes(buf[: len(buf) // 2 * 2])
    return (sum(x * x for x in a) / len(a)) ** 0.5 if a else 0.0


def mint_token(session_path: str, timeout: int = 30) -> str:
    from curl_cffi import requests as creq
    sess = json.load(open(session_path))
    H = {"User-Agent": sess["userAgent"], "Cookie": sess["cookie"], "Origin": GROK,
         "Referer": GROK + "/", "Content-Type": "application/json"}
    r = creq.post(GROK + "/rest/livekit/tokens", impersonate="chrome", headers=H,
                  data=json.dumps({"requestAgentDispatch": True}), timeout=timeout)
    if r.status_code in (401, 403):
        raise PermissionError("relogin")
    r.raise_for_status()
    return r.json()["token"]


def to_pcm48k(path: str) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-y", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-loglevel", "error", "pipe:1"],
        check=True, capture_output=True).stdout


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def read_line() -> str:
    return await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)


async def main(session_path: str) -> int:
    from livekit import rtc

    try:
        token = mint_token(session_path)
    except PermissionError:
        emit({"event": "error", "errorClass": "relogin", "detail": "grok session dead"}); return 1

    agent_pcm = bytearray()
    agent_id = {"v": None}
    joined = asyncio.Event()
    room = rtc.Room()

    @room.on("participant_connected")
    def _pc(p):
        agent_id["v"] = p.identity
        joined.set()

    @room.on("track_subscribed")
    def _ts(track, pub, participant):
        if int(track.kind) == 1:
            async def drain():
                stream = rtc.AudioStream(track, sample_rate=SR, num_channels=1)
                async for ev in stream:
                    agent_pcm.extend(bytes(ev.frame.data))
            asyncio.create_task(drain())

    await room.connect(LIVEKIT_URL, token, rtc.RoomOptions(auto_subscribe=True))
    source = rtc.AudioSource(SR, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    try:
        await asyncio.wait_for(joined.wait(), timeout=12)
    except asyncio.TimeoutError:
        emit({"event": "error", "errorClass": "no_agent", "detail": "agent did not join"})
        await room.disconnect(); return 1
    emit({"event": "ready", "agentIdentity": agent_id["v"]})

    turn = 0
    while True:
        line = (await read_line()).strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except ValueError:
            emit({"event": "error", "errorClass": "bad_request", "detail": "invalid JSON command"}); continue
        if cmd.get("cmd") == "quit":
            break
        if cmd.get("cmd") != "speak":
            emit({"event": "error", "errorClass": "bad_request", "detail": f"unknown cmd {cmd.get('cmd')!r}"}); continue

        turn += 1
        start = len(agent_pcm)          # capture the reply from here (barge-in truncates any prior reply)
        pcm = to_pcm48k(cmd["wav"])
        chunk = FRAME * 2
        for off in range(0, max(0, len(pcm) - chunk), chunk):
            await source.capture_frame(rtc.AudioFrame(pcm[off:off + chunk], SR, 1, FRAME))
        # Turn boundaries are audio-based (the agent track genuinely falls to ~0
        # between replies; `lk.agent.state` does NOT reliably reset, so it can't be
        # used). Wait for the agent's speech ONSET, then for a trailing-silence
        # hangover. `onset` is where the reply's audio begins.
        def tail() -> bytes:
            return bytes(agent_pcm[-WIN_BYTES:]) if len(agent_pcm) >= WIN_BYTES else bytes(agent_pcm[start:])

        onset = None
        onset_deadline = time.time() + SPEAK_START_TIMEOUT_S
        while time.time() < onset_deadline:
            await asyncio.sleep(0.05)
            if rms(tail()) > SIL_RMS:
                onset = len(agent_pcm) - WIN_BYTES
                break
        if onset is None:
            emit({"event": "reply", "turn": turn, "path": cmd.get("out", ""), "bytes": 44, "durationMs": 0, "detail": "no agent reply"})
            continue

        deadline = time.time() + MAX_REPLY_S
        last_voiced = len(agent_pcm)
        silent_since = None
        while time.time() < deadline:
            await asyncio.sleep(0.1)
            if rms(tail()) > SIL_RMS:
                last_voiced = len(agent_pcm)
                silent_since = None
            else:
                if silent_since is None:
                    silent_since = time.time()
                elif time.time() - silent_since > HANGOVER_S:
                    break
        reply = bytes(agent_pcm[max(start, onset):last_voiced])
        out = cmd.get("out", f"/tmp/grok-session-reply-{turn}.wav")
        with wave.open(out, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(reply)
        emit({"event": "reply", "turn": turn, "path": out, "bytes": len(reply) + 44,
              "durationMs": int(len(reply) / 2 / SR * 1000)})

    await room.disconnect()
    emit({"event": "bye"})
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        emit({"event": "error", "errorClass": "bad_request", "detail": "usage: grok_livekit_session.py <session.json>"}); sys.exit(1)
    try:
        sys.exit(asyncio.run(main(sys.argv[1])))
    except Exception as e:
        emit({"event": "error", "errorClass": "exception", "detail": f"{type(e).__name__}: {e}"}); sys.exit(1)
