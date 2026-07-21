#!/usr/bin/env python3
"""Grok persistent user memory (blurb + imported memory) — browserless, on the
$30 seat.

All lanes are seat-covered, cookie-only and statsig-FREE (proven live
2026-07-21):
  * GET    grok.com/rest/app-chat/user-memory-blurb   -> {"memoryContent": "..."}
  * PUT    grok.com/rest/app-chat/user-memory-blurb   {"memoryContent": X}
           -> 200 echo. NOTE (probed live): on the current seat the PUT is
           accepted (200, echoes the new content) but a subsequent GET still
           returns the old value — server-side gating silently drops the write.
           blurb_set therefore ALWAYS re-reads and reports `persisted`.
  * DELETE grok.com/rest/app-chat/user-memory-blurb   -> 200 {}
  * GET    grok.com/rest/app-chat/import-memory        -> {"content": "..."}
  * GET    grok.com/rest/app-chat/import-memory/status -> {"status": "IMPORTED_MEMORY_STATUS_*"}

NOT wired (probed live 2026-07-21, server-side broken/unreachable — do not
"fix" by guessing): POST /rest/app-chat/memory (per-conversation memory list)
returns 500 "Failed to get memory" with AND without valid conversationIds;
GET /rest/app-chat/memories_v2/{companionId} is companion-scoped and 500s
without a real companion id. DELETE /rest/app-chat/memory_v2/{id} is therefore
unverifiable (no id source).

Contract (mirror grok_models.py): ONE JSON request on stdin, ONE JSON response
on stdout. Secrets (cookie, userAgent) arrive on stdin ONLY and are never
echoed.

Request:
  {"cookie": "...", "userAgent": "...",
   "op": "blurb_get"|"blurb_set"|"blurb_clear"|"imported_get",
   "memoryContent": "...",   # blurb_set only
   "timeoutSec": 40}
Response:
  op=blurb_get    -> {"ok": true, "memoryContent": "..."}
  op=blurb_set    -> {"ok": true, "memoryContent": <requested>, "persisted": bool,
                      "readBack": <what GET returns after the PUT>}
  op=blurb_clear  -> {"ok": true, "persisted": bool}
  op=imported_get -> {"ok": true, "content": "...", "importStatus": "..."}
  or {"ok": false, "errorClass": "cloudflare|relogin|http_error|bad_request|exception", "detail": "..."}

Needs: curl_cffi. Same-host as the captured session (cf_clearance is IP-bound).
"""
import json
import sys

GROK = "https://grok.com"
BLURB = "/rest/app-chat/user-memory-blurb"


def call(method: str, path: str, body, cookie: str, ua: str, timeout: int):
    from curl_cffi import requests as creq
    H = {"User-Agent": ua, "Cookie": cookie, "Origin": GROK, "Referer": GROK + "/",
         "Content-Type": "application/json"}
    return creq.request(method, GROK + path, impersonate="chrome", headers=H,
                        data=json.dumps(body) if body is not None else None,
                        timeout=timeout)


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


def read_blurb(req: dict):
    """GET the blurb; returns (dict_error, None) or (None, content)."""
    r = call("GET", BLURB, None, req["cookie"], req["userAgent"],
             int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r), None
    return None, r.json().get("memoryContent", "")


def op_blurb_get(req: dict) -> dict:
    err, content = read_blurb(req)
    if err:
        return err
    return {"ok": True, "memoryContent": content}


def op_blurb_set(req: dict) -> dict:
    content = req.get("memoryContent")
    if not isinstance(content, str) or not content.strip():
        return {"ok": False, "errorClass": "bad_request", "detail": "missing memoryContent"}
    r = call("PUT", BLURB, {"memoryContent": content},
             req["cookie"], req["userAgent"], int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    # The PUT can 200 yet be silently dropped server-side — always verify.
    err, read_back = read_blurb(req)
    if err:
        return err
    return {"ok": True, "memoryContent": content,
            "persisted": read_back == content, "readBack": read_back}


def op_blurb_clear(req: dict) -> dict:
    r = call("DELETE", BLURB, None, req["cookie"], req["userAgent"],
             int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    err, read_back = read_blurb(req)
    if err:
        return err
    return {"ok": True, "persisted": read_back == ""}


def op_imported_get(req: dict) -> dict:
    t = int(req.get("timeoutSec", 40))
    r = call("GET", "/rest/app-chat/import-memory", None,
             req["cookie"], req["userAgent"], t)
    if r.status_code != 200:
        return classify_http(r)
    content = r.json().get("content", "")
    rs = call("GET", "/rest/app-chat/import-memory/status", None,
              req["cookie"], req["userAgent"], t)
    status = rs.json().get("status", "") if rs.status_code == 200 else ""
    return {"ok": True, "content": content, "importStatus": status}


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
    ops = {"blurb_get": op_blurb_get, "blurb_set": op_blurb_set,
           "blurb_clear": op_blurb_clear, "imported_get": op_imported_get}
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
