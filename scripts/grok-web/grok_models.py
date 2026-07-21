#!/usr/bin/env python3
"""Grok model catalog + rate limits — browserless, on the $30 seat.

Both endpoints are seat-covered, cookie-only and statsig-FREE (proven live
2026-07-21):
  * POST grok.com/rest/models       {"locale":"en"}  -> {models:[...],
    unavailableModels, defaultFreeModel, defaultProModel, defaultHeavyModel,
    defaultAnonModel, default*Mode}
  * POST grok.com/rest/rate-limits  {"requestKind":"DEFAULT","modelName":X}
    -> {windowSizeSeconds, remainingQueries, totalQueries,
        lowEffortRateLimits, highEffortRateLimits}

Contract (mirror grok_web_replay.py): ONE JSON request on stdin, ONE JSON
response on stdout. Secrets (cookie, userAgent) arrive on stdin ONLY and are
never echoed.

Request:
  {"cookie": "...", "userAgent": "...", "op": "models"|"rate_limits",
   "modelName": "grok-4",          # rate_limits only
   "requestKind": "DEFAULT",       # rate_limits only (DEFAULT|DEEPSEARCH...)
   "locale": "en", "timeoutSec": 40}
Response:
  op=models      -> {"ok": true, "models": [...], "unavailableModels": [...],
                     "defaults": {"free": ..., "pro": ..., "heavy": ..., "anon": ...,
                                  "freeMode": ..., "proMode": ..., "heavyMode": ..., "anonMode": ...}}
  op=rate_limits -> {"ok": true, "modelName": ..., "requestKind": ...,
                     "windowSizeSeconds": N, "remainingQueries": N, "totalQueries": N,
                     "lowEffortRateLimits": ..., "highEffortRateLimits": ...}
  or {"ok": false, "errorClass": "cloudflare|relogin|http_error|bad_request|exception", "detail": "..."}

Needs: curl_cffi. Same-host as the captured session (cf_clearance is IP-bound).
"""
import json
import sys

GROK = "https://grok.com"


def post(path: str, body: dict, cookie: str, ua: str, timeout: int):
    from curl_cffi import requests as creq
    H = {"User-Agent": ua, "Cookie": cookie, "Origin": GROK, "Referer": GROK + "/",
         "Content-Type": "application/json"}
    return creq.post(GROK + path, impersonate="chrome", headers=H,
                     data=json.dumps(body), timeout=timeout)


def classify_http(r) -> dict:
    """Structured non-2xx handling. Never includes cookie material."""
    text = r.text or ""
    if r.status_code == 403 and "just a moment" in text[:500].lower():
        return {"ok": False, "status": r.status_code, "errorClass": "cloudflare",
                "detail": "Cloudflare challenge — refresh cf_clearance/__cf_bm"}
    if r.status_code == 401 or (r.status_code == 403 and "sign-in" in text[:500].lower()):
        return {"ok": False, "status": r.status_code, "errorClass": "relogin",
                "detail": "grok session dead — re-provision websession"}
    return {"ok": False, "status": r.status_code, "errorClass": "http_error",
            "detail": f"HTTP {r.status_code}: {text[:300]}"}


def op_models(req: dict) -> dict:
    r = post("/rest/models", {"locale": req.get("locale", "en")},
             req["cookie"], req["userAgent"], int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    j = r.json()
    return {
        "ok": True,
        "models": j.get("models", []),
        "unavailableModels": j.get("unavailableModels", []),
        "defaults": {
            "free": j.get("defaultFreeModel"),
            "pro": j.get("defaultProModel"),
            "heavy": j.get("defaultHeavyModel"),
            "anon": j.get("defaultAnonModel"),
            "freeMode": j.get("defaultFreeMode"),
            "proMode": j.get("defaultProMode"),
            "heavyMode": j.get("defaultHeavyMode"),
            "anonMode": j.get("defaultAnonMode"),
        },
    }


def op_rate_limits(req: dict) -> dict:
    model = (req.get("modelName") or "").strip()
    if not model:
        return {"ok": False, "errorClass": "bad_request", "detail": "missing modelName"}
    kind = req.get("requestKind") or "DEFAULT"
    r = post("/rest/rate-limits", {"requestKind": kind, "modelName": model},
             req["cookie"], req["userAgent"], int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    j = r.json()
    return {
        "ok": True,
        "modelName": model,
        "requestKind": kind,
        "windowSizeSeconds": j.get("windowSizeSeconds"),
        "remainingQueries": j.get("remainingQueries"),
        "totalQueries": j.get("totalQueries"),
        "lowEffortRateLimits": j.get("lowEffortRateLimits"),
        "highEffortRateLimits": j.get("highEffortRateLimits"),
    }


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"invalid JSON: {e}"}))
        return
    for k in ("cookie", "userAgent", "op"):
        if not req.get(k):
            print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"missing {k}"}))
            return
    ops = {"models": op_models, "rate_limits": op_rate_limits}
    fn = ops.get(req["op"])
    if fn is None:
        print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"unknown op {req['op']!r}"}))
        return
    try:
        print(json.dumps(fn(req)))
    except Exception as e:  # never leak secrets
        print(json.dumps({"ok": False, "errorClass": "exception", "detail": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
