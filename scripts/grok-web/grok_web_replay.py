#!/usr/bin/env python3
"""GW2 — Grok web-session replay bridge (GrokWebSession campaign).

The ONLY component that needs Python: it replays a captured grok.com browser
session server-side, past Cloudflare, to use image/video generation on the user's
Grok subscription for free. Protocol: docs/grok-web-imagine-protocol.md (GW1).

Transport matrix (PROVEN 2026-07-20, must stay same-host as the capture browser):
  * REST (quota_info / post/create / app-chat) -> curl_cffi impersonate="chrome"
    (a plain client gets a Cloudflare 403). app-chat additionally needs a valid
    x-statsig-id (captured from the browser; reusable within a window).
  * Image WebSocket (wss://grok.com/ws/imagine/listen) -> the `websocket-client`
    library, NOT curl_cffi (curl_cffi's WS support is broken in-env: curl err 52 /
    GOT_NOTHING on every server). The WS upgrade passes Cloudflare with only the
    Cookie header once cf_clearance is valid; no TLS impersonation is needed there.

Contract: ONE JSON request object on stdin, ONE JSON response object on stdout.
Secrets (cookie header, statsig id) arrive on stdin ONLY and are NEVER echoed to
stdout/stderr. Any error is returned as {"ok": false, "errorClass": "...", ...}
so the Node manager can distinguish 403-cloudflare / 403-statsig / 404-grpc /
401-relogin (see classify()).

Requests:
  {"op":"probe"}
    -> {"ok":true,"status":200,"quota":{...}}
  {"op":"image","prompt":"...","aspectRatio":"1:1","numGenerations":1,"pro":false,
   "timeoutSec":90}
    -> {"ok":true,"images":[{"jobId":"...","b64":"<base64 jpeg>",
        "publicUrl":"https://imagine-public.x.ai/imagine-public/images/<jobId>.jpg"}]}
  {"op":"video","imageUrl":"https://imagine-public.x.ai/.../<jobId>.jpg",
   "aspectRatio":"9:16","videoLength":6,"resolutionName":"720p","timeoutSec":150}
    -> {"ok":true,"videoUrl":"https://assets.grok.com/users/<uid>/generated/<vid>/generated_video.mp4",
        "thumbnailUrl":"https://assets.grok.com/.../preview_image.jpg","videoId":"<vid>"}

Common request fields: cookie (str, required), userAgent (str, required),
statsigId (str, required for op=video).
"""

import base64
import json
import sys
import time
import uuid

GROK = "https://grok.com"
WS_URL = "wss://grok.com/ws/imagine/listen"
IMAGINE_PUBLIC = "https://imagine-public.x.ai/imagine-public/images/{job}.jpg"
ASSETS = "https://assets.grok.com/"


def base_headers(req):
    return {
        "User-Agent": req["userAgent"],
        "Cookie": req["cookie"],
        "Origin": GROK,
        "Referer": GROK + "/imagine",
    }


def classify(status, body_text):
    """Map an HTTP status + body to an error class the Node side acts on."""
    low = (body_text or "")[:400].lower()
    if status == 403:
        if "just a moment" in low or "cloudflare" in low or "cf-" in low or "<html" in low:
            return "cloudflare"  # -> refresh cf_clearance/__cf_bm
        return "statsig"  # app-chat 403 with valid cookies -> re-capture x-statsig-id
    if status == 404 and '"code":5' in (body_text or ""):
        return "grpc_not_found"  # wrong path, do NOT refresh cookies
    if status in (401,) or "login" in low or "/sign-in" in low:
        return "relogin"  # sso dead
    return "http_error"


def op_probe(req):
    from curl_cffi import requests as creq

    r = creq.post(
        GROK + "/rest/media/imagine/quota_info",
        data="{}",
        headers={**base_headers(req), "Content-Type": "application/json"},
        impersonate="chrome",
        timeout=req.get("timeoutSec", 30),
    )
    if r.status_code != 200:
        return {"ok": False, "status": r.status_code, "errorClass": classify(r.status_code, r.text)}
    return {"ok": True, "status": 200, "quota": _safe_json(r.text)}


def op_seed(req):
    """Fetch a fresh page seed — the <meta name^=gr> content baked into the grok
    /imagine HTML — for the pure-Node (browserless) x-statsig-id minter. curl_cffi
    GET (Chrome-impersonated, seat cookies) since grok.com sits behind Cloudflare.
    The seed is a value, not a secret; the token is minted from it in Node."""
    import re
    from curl_cffi import requests as creq

    r = creq.get(
        GROK + "/imagine",
        headers=base_headers(req),
        impersonate="chrome",
        timeout=req.get("timeoutSec", 30),
    )
    if r.status_code != 200:
        return {"ok": False, "status": r.status_code, "errorClass": classify(r.status_code, r.text)}
    m = re.search(r'name="grok-site[^"]*"\s+content="([^"]+)"', r.text)
    if not m:
        m = re.search(r'<meta[^>]*content="([A-Za-z0-9+/]{62,68})"[^>]*>', r.text)
    if not m:
        return {"ok": False, "status": 200, "errorClass": "no_seed", "detail": "seed meta not present in HTML"}
    return {"ok": True, "status": 200, "seed": m.group(1)}


def op_image(req):
    import websocket  # websocket-client

    ua = req["userAgent"]
    ws = websocket.create_connection(
        WS_URL,
        header=[f"User-Agent: {ua}", f"Origin: {GROK}"],
        cookie=req["cookie"],
        timeout=req.get("timeoutSec", 90),
    )
    try:
        status = getattr(ws, "getstatus", lambda: None)()
        if status and status != 101:
            return {"ok": False, "status": status, "errorClass": "cloudflare"}
        n = int(req.get("numGenerations", 1))
        ws.send(json.dumps({
            "type": "conversation.item.create",
            "timestamp": int(time.time() * 1000),
            "item": {"type": "message", "content": [{"type": "reset"}]},
        }))
        ws.send(json.dumps({
            "type": "conversation.item.create",
            "timestamp": int(time.time() * 1000),
            "item": {"type": "message", "content": [{
                "requestId": str(uuid.uuid4()),
                "text": req["prompt"],
                "type": "input_text",
                "properties": {
                    "section_count": 0, "is_kids_mode": False, "enable_nsfw": False,
                    "skip_upsampler": False, "enable_side_by_side": True,
                    "is_initial": False, "aspect_ratio": req.get("aspectRatio", "1:1"),
                    "enable_pro": bool(req.get("pro", False)), "num_generations": n,
                },
            }]}}
        ))
        # Keep the largest blob per job_id; stop when all jobs report completed.
        best = {}          # job_id -> (size, b64)
        completed = set()
        started = set()
        deadline = time.time() + req.get("timeoutSec", 90)
        while time.time() < deadline:
            try:
                msg = ws.recv()
            except Exception:
                break
            txt = msg if isinstance(msg, str) else msg.decode("utf-8", "replace")
            try:
                j = json.loads(txt)
            except ValueError:
                continue
            t = j.get("type")
            if t == "json":
                job = j.get("job_id")
                if job:
                    started.add(job)
                    if j.get("current_status") == "completed":
                        completed.add(job)
                if started and completed >= started and len(best) >= min(n, len(started)):
                    break
            elif t == "image":
                blob = j.get("blob") or ""
                raw = base64.b64decode(blob) if blob else b""
                # associate with the most-recently-started job lacking a full-res blob
                job = j.get("job_id") or (sorted(started - set(best))[:1] or [None])[0]
                if job is None:
                    job = f"_{len(best)}"
                if len(raw) > best.get(job, (0, ""))[0]:
                    best[job] = (len(raw), blob)
        images = [
            {"jobId": (job if not job.startswith("_") else None),
             "b64": b64,
             "publicUrl": (IMAGINE_PUBLIC.format(job=job) if not job.startswith("_") else None)}
            for job, (_sz, b64) in best.items() if _sz > 0
        ]
        if not images:
            return {"ok": False, "errorClass": "no_images",
                    "detail": "WS produced no image frames (stale cf_clearance?)"}
        return {"ok": True, "images": images}
    finally:
        try:
            ws.close()
        except Exception:
            pass


def op_video(req):
    """Kick off a video via the app-chat stream. GWV2: the x-statsig-id is minted
    FRESH per request by the Node-side headless oracle and arrives in req.
    Text-to-video (PROVEN) is the default; image-to-video runs when imageUrl is
    given (publishes the source image as a post first). Returns STRUCTURED fields
    only (URLs / ids) — never free-form model text (quarantine posture)."""
    from curl_cffi import requests as creq

    if not req.get("statsigId"):
        return {"ok": False, "errorClass": "statsig", "detail": "x-statsig-id required for video"}
    H = {**base_headers(req), "Content-Type": "application/json"}
    tmo = req.get("timeoutSec", 180)
    video_cfg = {
        "aspectRatio": req.get("aspectRatio", "9:16"),
        "videoLength": req.get("videoLength", 6),
        "resolutionName": req.get("resolutionName", "720p"),
    }
    img_url = req.get("imageUrl")

    if img_url:
        # image-to-video: publish the source image as a post so it has an id.
        r1 = creq.post(GROK + "/rest/media/post/create", impersonate="chrome", headers=H,
                       data=json.dumps({"mediaType": "MEDIA_POST_TYPE_IMAGE", "mediaUrl": img_url}),
                       timeout=30)
        if r1.status_code != 200:
            return {"ok": False, "status": r1.status_code, "errorClass": classify(r1.status_code, r1.text)}
        post_id = _safe_json(r1.text).get("post", {}).get("id")
        if post_id:
            video_cfg["parentPostId"] = post_id
        message = f"{img_url}  --mode=normal"
    else:
        # text-to-video (PROVEN): the prompt drives it, custom mode.
        prompt = req.get("prompt") or ""
        if not prompt:
            return {"ok": False, "errorClass": "bad_request", "detail": "video needs prompt or imageUrl"}
        message = f"{prompt} --mode=custom"

    body = {
        "temporary": True, "modelName": "imagine-video-gen",
        "message": message, "enableSideBySide": True,
        "responseMetadata": {"experiments": [], "modelConfigOverride": {"modelMap": {
            "videoGenModelConfig": video_cfg}}},
    }
    vh = {**H, "x-statsig-id": req["statsigId"], "x-xai-request-id": str(uuid.uuid4())}
    r2 = creq.post(GROK + "/rest/app-chat/conversations/new", impersonate="chrome",
                   headers=vh, data=json.dumps(body), stream=True, timeout=tmo)
    if r2.status_code != 200:
        return {"ok": False, "status": r2.status_code, "errorClass": classify(r2.status_code, r2.text)}
    deadline = time.time() + tmo
    for line in r2.iter_lines():
        if time.time() > deadline:
            return {"ok": False, "errorClass": "timeout", "detail": "video stream did not reach progress 100"}
        if not line:
            continue
        s = line.decode("utf-8", "replace") if isinstance(line, (bytes, bytearray)) else line
        if "streamingVideoGenerationResponse" in s and '"progress":100' in s:
            try:
                vr = json.loads(s)["result"]["response"]["streamingVideoGenerationResponse"]
            except (ValueError, KeyError):
                continue
            return {
                "ok": True,
                "videoUrl": ASSETS + vr["videoUrl"],
                "thumbnailUrl": ASSETS + vr.get("thumbnailImageUrl", ""),
                "videoId": vr.get("videoId"),
            }
    return {"ok": False, "errorClass": "stream_ended", "detail": "app-chat stream ended before progress 100"}


def op_download(req):
    """Download a generated asset (assets.grok.com mp4) with the session cookies,
    same-host, to a local path. Returns bytes + an ISO-MP4 ftyp-magic check."""
    from curl_cffi import requests as creq

    url = req.get("url")
    out = req.get("outputPath")
    if not url or not out:
        return {"ok": False, "errorClass": "bad_request", "detail": "download needs url and outputPath"}
    r = creq.get(url, impersonate="chrome", headers=base_headers(req),
                 timeout=req.get("timeoutSec", 120))
    if r.status_code != 200:
        return {"ok": False, "status": r.status_code, "errorClass": classify(r.status_code, getattr(r, "text", ""))}
    data = r.content
    with open(out, "wb") as f:
        f.write(data)
    ftyp = len(data) >= 12 and data[4:8] == b"ftyp"
    return {"ok": True, "status": 200, "path": out, "bytes": len(data), "ftyp": bool(ftyp)}


def op_voice_stt(req):
    """Transcribe audio on the Grok subscription voice lane (seat-covered,
    statsig-free — proven 2026-07-20). JSON in, JSON out; returns the transcript
    plus per-word timing. No x-statsig-id needed (unlike video)."""
    from curl_cffi import requests as creq

    audio_b64 = req.get("audioBase64")
    if not audio_b64:
        return {"ok": False, "errorClass": "bad_request", "detail": "voice_stt needs audioBase64"}
    body = {
        "audioBase64": audio_b64,
        "audioFormat": req.get("audioFormat", "wav"),
        "enhance": bool(req.get("enhance", False)),
    }
    r = creq.post(
        GROK + "/rest/voice/speech-to-text",
        data=json.dumps(body),
        headers={**base_headers(req), "Content-Type": "application/json"},
        impersonate="chrome",
        timeout=req.get("timeoutSec", 60),
    )
    if r.status_code != 200:
        return {"ok": False, "status": r.status_code, "errorClass": classify(r.status_code, r.text)}
    j = _safe_json(r.text)
    return {"ok": True, "status": 200, "text": j.get("text", ""),
            "words": j.get("words", []), "samplingTime": j.get("samplingTime")}


def _wrap_wav(pcm, rate):
    """Wrap raw 16-bit mono little-endian PCM in a canonical WAV container."""
    import struct
    n = len(pcm)
    return (b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
            + b"data" + struct.pack("<I", n) + pcm)


def op_voice_tts(req):
    """Synthesise speech on the Grok subscription voice lane (seat-covered,
    statsig-free — proven 2026-07-20). The app-chat/tts route streams JSON docs
    {"result":{"data":<b64>}}; concatenating the decoded bytes yields a
    multipart/form-data (boundary=frame) body whose audio parts are
    `audio/l16;rate=<hz>` (16-bit mono PCM). We reassemble the PCM by
    Content-Length (never rstrip — PCM may end in 0x0d0a) and wrap it in WAV."""
    from curl_cffi import requests as creq

    text = (req.get("text") or "").strip()
    if not text:
        return {"ok": False, "errorClass": "bad_request", "detail": "voice_tts needs text"}
    body = {
        "articles": [{"text": text}],
        "sanitize": bool(req.get("sanitize", True)),
        "enableAlignment": bool(req.get("enableAlignment", True)),
    }
    voice = req.get("voice")
    if voice:
        body["voice"] = voice

    r = creq.post(
        GROK + "/rest/app-chat/tts",
        data=json.dumps(body),
        headers={**base_headers(req), "Content-Type": "application/json"},
        impersonate="chrome",
        stream=True,
        timeout=req.get("timeoutSec", 90),
    )
    if r.status_code != 200:
        return {"ok": False, "status": r.status_code, "errorClass": classify(r.status_code, getattr(r, "text", ""))}

    buf = bytearray()
    for chunk in r.iter_content():
        if chunk:
            buf += chunk

    dec = json.JSONDecoder()
    s = bytes(buf).decode("utf-8", "replace")
    multipart = bytearray()
    words = []
    i = 0
    while i < len(s):
        while i < len(s) and s[i] in " \r\n\t":
            i += 1
        if i >= len(s):
            break
        try:
            obj, end = dec.raw_decode(s, i)
        except ValueError:
            break
        i = end
        d = obj.get("result", {}).get("data") if isinstance(obj, dict) else None
        if d:
            multipart += base64.b64decode(d)

    pcm = bytearray()
    rate = 24000
    for seg in bytes(multipart).split(b"--frame"):
        seg = seg.lstrip(b"-").lstrip(b"\r\n")
        if b"\r\n\r\n" not in seg:
            continue
        hdr, part = seg.split(b"\r\n\r\n", 1)
        htxt = hdr.decode("latin1").lower()
        clen = None
        for line in hdr.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                try:
                    clen = int(line.split(b":", 1)[1].strip())
                except ValueError:
                    clen = None
        if "audio/l16" in htxt:
            if "rate=" in htxt:
                try:
                    rate = int(htxt.split("rate=")[1].split(";")[0].split("\r")[0].strip())
                except ValueError:
                    pass
            pcm += part[:clen] if clen is not None else part.rstrip(b"\r\n")
        elif "application/json" in htxt and clen:
            wj = _safe_json(part[:clen].decode("utf-8", "replace"))
            if wj.get("words"):
                words.extend(wj["words"])

    if not pcm:
        return {"ok": False, "errorClass": "no_audio",
                "detail": "tts stream produced no audio frames (stale session?)"}
    wav = _wrap_wav(bytes(pcm), rate)
    return {"ok": True, "status": 200, "audioBase64": base64.b64encode(wav).decode(),
            "audioFormat": "wav", "sampleRate": rate,
            "durationMs": int(len(pcm) / 2 / rate * 1000), "words": words}


def _safe_json(text):
    try:
        return json.loads(text)
    except ValueError:
        return {}


OPS = {"probe": op_probe, "seed": op_seed, "image": op_image, "video": op_video,
       "download": op_download, "voice_stt": op_voice_stt, "voice_tts": op_voice_tts}


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"invalid JSON: {e}"}))
        return
    op = req.get("op")
    fn = OPS.get(op)
    if fn is None:
        print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"unknown op: {op}"}))
        return
    for k in ("cookie", "userAgent"):
        if not req.get(k):
            print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"missing {k}"}))
            return
    try:
        print(json.dumps(fn(req)))
    except Exception as e:  # never leak secrets in the message
        print(json.dumps({"ok": False, "errorClass": "exception", "detail": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
