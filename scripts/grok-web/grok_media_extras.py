#!/usr/bin/env python3
"""GrokMediaExtras — free video caption + upscale on the $30 grok.com seat.

Siblings of the already-wired image/video generation lane, riding the same
cookie-authenticated `/rest/media/*` surface the web UI uses. Both ops here are
cookie-only, statsig-FREE (PROVEN LIVE 2026-07-21 — a bare cookie call reaches
the endpoint and gets a business 400/403, never a 403 Cloudflare/statsig):

  upscale  POST /rest/media/video/upscale
             body {videoId, targetResolution}
               targetResolution in {UPSCALE_TARGET_RESOLUTION_HD,
                                     UPSCALE_TARGET_RESOLUTION_1080P}
             -> 200 {hdMediaUrl}   (DIRECT url, synchronous; no poll)
           Works on any video the seat can see (no ownership gate observed).

  caption  POST /rest/media/video/caption
             body {videoId, preset?, style?, canvasId?, containerId?}
             -> 200 {result:{postId, status, progressPct, message, errorMessage}}
           A JOB result (status/progressPct). REQUIRES the seat to OWN the
           video (403 code 7 "Only the video owner can generate captions" on a
           public-feed video); 400 code 3 "invalid video_id" on an unknown id.

  download GET  <assets url from caption/upscale> -> a local, path-validated file
           (only when the caller asks). Host allow-list + no path traversal.

`/rest/app-chat/image-generations` is DELIBERATELY ABSENT: it is a GET that
LISTS prior image generations (history), not a generator — redundant with the
already-wired imagine image lane. Not wired (see grok-media-extras.ts).

Contract: ONE JSON request on stdin, ONE JSON response on stdout. Secrets
(cookie, userAgent) arrive on stdin ONLY and are NEVER echoed. Errors return
{"ok": false, "errorClass": "...", "detail": "..."} mirroring grok-web-bridge.ts.
"""

import json
import os
import re
import sys

GROK = "https://grok.com"
# Generated media assets live only on these hosts; a download URL must match one.
ALLOWED_ASSET_HOSTS = ("https://assets.grok.com/", "https://imagine-public.x.ai/")
# videoId is a UUID; validate before it is ever placed in a request body.
UUID_RE = re.compile(r"^[0-9a-fA-F-]{32,40}$")
UPSCALE_TARGETS = ("UPSCALE_TARGET_RESOLUTION_HD", "UPSCALE_TARGET_RESOLUTION_1080P")


def base_headers(req):
    return {
        "User-Agent": req["userAgent"],
        "Cookie": req["cookie"],
        "Origin": GROK,
        "Referer": GROK + "/",
        "Content-Type": "application/json",
    }


def classify(status, body_text):
    """Map an HTTP status + body to an error class the Node side acts on."""
    low = (body_text or "")[:400].lower()
    if status == 403:
        if "just a moment" in low or "cloudflare" in low or "cf-" in low or "<html" in low:
            return "cloudflare"  # refresh cf_clearance/__cf_bm
        return "forbidden"  # e.g. not the video owner (caption)
    if status == 401 or "login" in low or "/sign-in" in low:
        return "relogin"  # sso dead
    if status == 400:
        return "bad_request"
    if status == 404:
        return "not_found"
    return "http_error"


def _http_fail(r, detail):
    return {"ok": False, "status": r.status_code,
            "errorClass": classify(r.status_code, r.text), "detail": detail}


def _safe_json(text):
    try:
        return json.loads(text)
    except ValueError:
        return {}


def _require_video_id(req):
    vid = (req.get("videoId") or "").strip()
    return vid if vid and UUID_RE.match(vid) else None


def op_upscale(req):
    from curl_cffi import requests as creq

    vid = _require_video_id(req)
    if not vid:
        return {"ok": False, "errorClass": "bad_request", "detail": "valid videoId required"}
    target = req.get("targetResolution", "UPSCALE_TARGET_RESOLUTION_HD")
    if target not in UPSCALE_TARGETS:
        return {"ok": False, "errorClass": "bad_request",
                "detail": f"targetResolution must be one of {UPSCALE_TARGETS}"}
    r = creq.post(GROK + "/rest/media/video/upscale", impersonate="chrome",
                  headers=base_headers(req),
                  data=json.dumps({"videoId": vid, "targetResolution": target}),
                  timeout=req.get("timeoutSec", 120))
    if r.status_code != 200:
        return _http_fail(r, "video upscale failed")
    hd = _safe_json(r.text).get("hdMediaUrl")
    if not hd:
        return {"ok": False, "errorClass": "bad_response",
                "detail": "upscale returned no hdMediaUrl"}
    return {"ok": True, "status": 200, "hdMediaUrl": hd}


def op_caption(req):
    from curl_cffi import requests as creq

    vid = _require_video_id(req)
    if not vid:
        return {"ok": False, "errorClass": "bad_request", "detail": "valid videoId required"}
    body = {"videoId": vid}
    for k in ("preset", "style", "canvasId", "containerId"):
        v = req.get(k)
        if v:
            body[k] = v
    r = creq.post(GROK + "/rest/media/video/caption", impersonate="chrome",
                  headers=base_headers(req), data=json.dumps(body),
                  timeout=req.get("timeoutSec", 120))
    if r.status_code != 200:
        return _http_fail(r, "video caption failed")
    result = _safe_json(r.text).get("result", {}) or {}
    return {"ok": True, "status": 200, "caption": {k: result.get(k) for k in (
        "postId", "status", "progressPct", "message", "errorMessage")}}


def _validate_output_path(out, output_dir):
    """Resolve an output path and confine it under the allowed base dir (blocks
    traversal). `output_dir` is supplied by the caller (defaults to cwd); we
    re-check here so the bridge is safe in isolation."""
    base = os.path.realpath(output_dir or os.getcwd())
    real = os.path.realpath(out)
    if real != base and not real.startswith(base + os.sep):
        return None
    return real


def op_download(req):
    from curl_cffi import requests as creq

    url = req.get("url") or ""
    out = req.get("outputPath") or ""
    if not url or not out:
        return {"ok": False, "errorClass": "bad_request", "detail": "download needs url and outputPath"}
    if not any(url.startswith(h) for h in ALLOWED_ASSET_HOSTS):
        return {"ok": False, "errorClass": "bad_request",
                "detail": "download url is not an allowed grok asset host"}
    safe_out = _validate_output_path(out, req.get("outputDir"))
    if not safe_out:
        return {"ok": False, "errorClass": "bad_request",
                "detail": "outputPath escapes the allowed output directory"}
    r = creq.get(url, impersonate="chrome", headers=base_headers(req),
                 timeout=req.get("timeoutSec", 180))
    if r.status_code != 200:
        return _http_fail(r, "asset download failed")
    data = r.content
    with open(safe_out, "wb") as f:
        f.write(data)
    ftyp = len(data) >= 12 and data[4:8] == b"ftyp"
    return {"ok": True, "status": 200, "path": safe_out, "bytes": len(data), "ftyp": bool(ftyp)}


OPS = {"upscale": op_upscale, "caption": op_caption, "download": op_download}


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"invalid JSON: {e}"}))
        return
    fn = OPS.get(req.get("op"))
    if fn is None:
        print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"unknown op: {req.get('op')}"}))
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
