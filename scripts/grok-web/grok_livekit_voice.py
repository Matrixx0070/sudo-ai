#!/usr/bin/env python3
"""Grok realtime voice — one turn over LiveKit, browserless, on the $30 seat.

grok.com voice mode runs on LiveKit (WebRTC). The subscription seat mints a room
token for free (POST /rest/livekit/tokens, cookies only, statsig-free); joining
the room auto-dispatches grok's "prod" voice agent. This bridge performs ONE
turn: publish the user's audio (a WAV), then capture the agent's spoken reply.

Contract (mirror grok_web_replay.py): ONE JSON request on stdin, ONE JSON
response on stdout. Secrets (cookie) arrive on stdin ONLY and are never echoed.

Request:
  {"cookie": "...", "userAgent": "...", "inputWav": "/path/user.wav",
   "outputPath": "/path/reply.wav", "captureSeconds": 12, "timeoutSec": 45}
Response:
  {"ok": true, "path": "/path/reply.wav", "bytes": N, "durationMs": M,
   "agentIdentity": "agent-...", "sampleRate": 48000}
  or {"ok": false, "errorClass": "relogin|timeout|no_agent|no_audio|exception", "detail": "..."}

Needs: `livekit` (pip), ffmpeg, curl_cffi. Same-host as the captured session.
"""
import asyncio, json, subprocess, sys, wave

GROK = "https://grok.com"
LIVEKIT_URL = "wss://livekit.grok.com"
SR = 48000


def mint_token(cookie: str, ua: str, timeout: int) -> str:
    from curl_cffi import requests as creq
    H = {"User-Agent": ua, "Cookie": cookie, "Origin": GROK, "Referer": GROK + "/",
         "Content-Type": "application/json"}
    r = creq.post(GROK + "/rest/livekit/tokens", impersonate="chrome", headers=H,
                  data=json.dumps({"requestAgentDispatch": True}), timeout=timeout)
    if r.status_code in (401, 403) or "sign-in" in (r.text[:200].lower()):
        raise PermissionError("relogin")
    r.raise_for_status()
    return r.json()["token"]


def to_pcm48k(path: str) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-y", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "-loglevel", "error", "pipe:1"],
        check=True, capture_output=True).stdout


async def run(req: dict) -> dict:
    from livekit import rtc

    cookie, ua = req["cookie"], req["userAgent"]
    out_path = req["outputPath"]
    capture_s = float(req.get("captureSeconds", 12))
    tmo = int(req.get("timeoutSec", 45))

    try:
        token = mint_token(cookie, ua, min(tmo, 30))
    except PermissionError:
        return {"ok": False, "errorClass": "relogin", "detail": "grok session dead — re-provision websession"}

    captured = bytearray()
    agent_id = {"v": None}
    joined = asyncio.Event()
    room = rtc.Room()

    @room.on("participant_connected")
    def _pc(p):
        agent_id["v"] = p.identity
        joined.set()

    @room.on("track_subscribed")
    def _ts(track, pub, participant):
        if int(track.kind) == 1:  # KIND_AUDIO
            async def drain():
                stream = rtc.AudioStream(track, sample_rate=SR, num_channels=1)
                async for ev in stream:
                    captured.extend(bytes(ev.frame.data))
            asyncio.create_task(drain())

    try:
        await asyncio.wait_for(room.connect(LIVEKIT_URL, token, rtc.RoomOptions(auto_subscribe=True)), timeout=tmo)
    except Exception as e:
        return {"ok": False, "errorClass": "timeout", "detail": f"livekit connect failed: {e}"}

    try:
        source = rtc.AudioSource(SR, 1)
        track = rtc.LocalAudioTrack.create_audio_track("mic", source)
        await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))

        try:
            await asyncio.wait_for(joined.wait(), timeout=10)
        except asyncio.TimeoutError:
            await room.disconnect()
            return {"ok": False, "errorClass": "no_agent", "detail": "grok voice agent did not join"}

        # Speak the user's audio (paced in 10ms frames), then capture the reply.
        pcm = to_pcm48k(req["inputWav"])
        chunk = int(SR * 0.01) * 2
        for off in range(0, max(0, len(pcm) - chunk), chunk):
            await source.capture_frame(rtc.AudioFrame(pcm[off:off + chunk], SR, 1, chunk // 2))
        await asyncio.sleep(capture_s)
    finally:
        await room.disconnect()

    if not captured:
        return {"ok": False, "errorClass": "no_audio", "detail": "no agent audio captured"}
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(bytes(captured))
    return {"ok": True, "path": out_path, "bytes": len(captured) + 44,
            "durationMs": int(len(captured) / 2 / SR * 1000), "sampleRate": SR,
            "agentIdentity": agent_id["v"]}


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"invalid JSON: {e}"})); return
    for k in ("cookie", "userAgent", "inputWav", "outputPath"):
        if not req.get(k):
            print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"missing {k}"})); return
    try:
        print(json.dumps(asyncio.run(run(req))))
    except Exception as e:  # never leak secrets
        print(json.dumps({"ok": False, "errorClass": "exception", "detail": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
