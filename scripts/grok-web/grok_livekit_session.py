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
import asyncio, json, os, pathlib, subprocess, sys, time, wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grok_turn_vad import AdaptiveTurnSegmenter  # noqa: E402

GROK = "https://grok.com"
LIVEKIT_URL = "wss://livekit.grok.com"
SR = 48000
FRAME = int(SR * 0.02)             # 20ms
MAX_REPLY_S = 40                    # hard cap per turn
SPEAK_START_TIMEOUT_S = 12         # how long to wait for the agent to begin replying
WIN_BYTES = int(SR * 0.4) * 2      # 400ms trailing window for the RMS estimate
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
    # The input path comes over the stdin protocol; require an existing LOCAL file
    # and whitelist only the file/pipe protocols so `ffmpeg -i` can never be tricked
    # into fetching a URL (http/rtmp/…) — no SSRF.
    p = pathlib.Path(path).resolve()
    if not p.is_file():
        raise ValueError(f"input audio must be an existing local file: {path!r}")
    return subprocess.run(
        ["ffmpeg", "-nostdin", "-protocol_whitelist", "file,pipe", "-y", "-i", str(p),
         "-f", "s16le", "-ac", "1", "-ar", str(SR), "-loglevel", "error", "pipe:1"],
        check=True, capture_output=True).stdout


def safe_out(path: str, roots: list) -> str:
    """Resolve `path` and require it to live under one of `roots` (defends against
    path traversal / symlink escape in the caller-supplied output path)."""
    p = pathlib.Path(path).resolve()
    if not any(p == r or str(p).startswith(str(r) + os.sep) for r in roots):
        raise ValueError(f"out path escapes allowed dirs: {path!r}")
    p.parent.mkdir(parents=True, exist_ok=True)
    return str(p)


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

    # Reply WAVs may only be written under DATA_DIR (the session file's dir) or /tmp.
    out_roots = [pathlib.Path(session_path).resolve().parent, pathlib.Path("/tmp").resolve()]
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
        # Validate the caller paths BEFORE any ffmpeg/file work (SSRF + traversal).
        try:
            out = safe_out(cmd.get("out", f"/tmp/grok-session-reply-{turn}.wav"), out_roots)
            pcm = to_pcm48k(cmd["wav"])
        except (ValueError, subprocess.CalledProcessError, KeyError) as e:
            emit({"event": "error", "errorClass": "bad_request", "detail": f"input rejected: {e}"}); continue
        chunk = FRAME * 2
        for off in range(0, max(0, len(pcm) - chunk), chunk):
            await source.capture_frame(rtc.AudioFrame(pcm[off:off + chunk], SR, 1, FRAME))
        # Turn boundaries are audio-based (the agent track genuinely falls to a
        # noise floor between replies; `lk.agent.state` does NOT reliably reset, so
        # it can't be used). The AdaptiveTurnSegmenter calibrates the noise floor
        # per turn and sets speech ENTER/EXIT thresholds RELATIVE to it (robust to
        # whatever idle level grok's agent emits), then ends the reply on a
        # trailing-silence hangover.
        # RMS over the trailing window of THIS TURN's audio only (from `start`), so
        # a prior reply's tail or the join greeting can't poison the calibration.
        def tail() -> bytes:
            seg_pcm = agent_pcm[start:]
            return bytes(seg_pcm[-WIN_BYTES:]) if len(seg_pcm) >= WIN_BYTES else bytes(seg_pcm)

        seg = AdaptiveTurnSegmenter(hangover_s=HANGOVER_S)
        onset_deadline = time.time() + SPEAK_START_TIMEOUT_S
        deadline = time.time() + MAX_REPLY_S
        t0 = time.monotonic()
        while time.time() < deadline:
            await asyncio.sleep(0.05)
            if seg.feed(rms(tail()), len(agent_pcm), time.monotonic() - t0) == "end":
                break
            if seg.state == AdaptiveTurnSegmenter.WAIT_ONSET and time.time() > onset_deadline:
                break  # agent never started replying

        if seg.onset_index is None:
            emit({"event": "reply", "turn": turn, "path": cmd.get("out", ""), "bytes": 44, "durationMs": 0, "detail": "no agent reply"})
            continue
        end = seg.end_index if seg.end_index is not None else len(agent_pcm)
        reply = bytes(agent_pcm[max(start, seg.onset_index):end])
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
