#!/usr/bin/env python3
"""Grok skills (installed + marketplace) — browserless, on the $30 seat.

All wired lanes are seat-covered, cookie-only and statsig-FREE (proven live
2026-07-22):
  * GET  grok.com/rest/user-skills                  -> {"skills":[{name, description,
         enabled, totalBytes, fileCount, files, createdAt, updatedAt,
         uploadFormat, skillMdContent}]}
  * GET  grok.com/rest/user-skills/search?q=...     -> same {"skills":[...]} shape
  * GET  grok.com/rest/user-skills/{name}           -> one skill object (full SKILL.md)
  * GET  grok.com/rest/verified-skills/published?pageSize=N
         -> {"skills":[...], "nextPageToken":""} (empty list on this seat, 200)
  * POST grok.com/rest/user-skills/{name}/enabled   {"enabled": bool} -> 200 echo of
         the skill. Round-trip proven live 2026-07-22 on browser-use
         (true -> false -> true, read-back verified each step, seat restored).
         set_enabled therefore ALWAYS re-reads and reports `persisted`.

NOT wired (probed live 2026-07-22 — do not "fix" by guessing):
  * GET /rest/verified-skills and /rest/verified-skills/search -> 403
    {"code":7,"message":"organization context required for organization skills"}
    — org-scoped, unreachable from a personal seat.
  * POST /rest/skill-link/{token}/install (install) + DELETE
    /rest/user-skills/{name} (uninstall): install needs a share-link *token*
    (from POST /rest/user-skills/{skillId}/share -> /rest/skill-link/{token}
    preview -> install). This seat has no shared skills and the marketplace is
    empty, so there is no token source to prove a safe install->uninstall
    round-trip; per the safety rule the write surface shipped is the (proven)
    enable/disable toggle only.

Contract (mirror grok_memory.py): ONE JSON request on stdin, ONE JSON response
on stdout. Secrets (cookie, userAgent) arrive on stdin ONLY and are never
echoed.

Request:
  {"cookie": "...", "userAgent": "...",
   "op": "list"|"search"|"get"|"verified_published"|"set_enabled",
   "q": "...",            # search only
   "name": "...",         # get / set_enabled only
   "enabled": true,       # set_enabled only
   "pageSize": 50,        # verified_published only
   "timeoutSec": 40}
Response:
  op=list/search        -> {"ok": true, "skills": [<summary>...]}
  op=get                -> {"ok": true, "skill": {..., "skillMdContent": "..."}}
  op=verified_published -> {"ok": true, "skills": [...], "nextPageToken": "..."}
  op=set_enabled        -> {"ok": true, "name": X, "enabled": bool,
                            "persisted": bool}   # read-back verified
  or {"ok": false, "errorClass": "cloudflare|relogin|http_error|bad_request|exception", "detail": "..."}

Needs: curl_cffi. Same-host as the captured session (cf_clearance is IP-bound).
"""
import json
import sys
from urllib.parse import quote

GROK = "https://grok.com"


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


def summarize(sk: dict) -> dict:
    """Compact one skill for list views (drop the full SKILL.md body)."""
    return {"name": sk.get("name", ""), "description": sk.get("description", ""),
            "enabled": bool(sk.get("enabled", False)),
            "fileCount": int(sk.get("fileCount", 0) or 0),
            "totalBytes": str(sk.get("totalBytes", "0")),
            "updatedAt": sk.get("updatedAt", "")}


def op_list(req: dict) -> dict:
    r = call("GET", "/rest/user-skills", None, req["cookie"], req["userAgent"],
             int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    skills = r.json().get("skills") or []
    return {"ok": True, "skills": [summarize(s) for s in skills]}


def op_search(req: dict) -> dict:
    q = req.get("q")
    if not isinstance(q, str) or not q.strip():
        return {"ok": False, "errorClass": "bad_request", "detail": "missing q"}
    r = call("GET", "/rest/user-skills/search?q=" + quote(q.strip()), None,
             req["cookie"], req["userAgent"], int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    skills = r.json().get("skills") or []
    return {"ok": True, "skills": [summarize(s) for s in skills]}


def read_skill(req: dict, name: str):
    """GET one skill; returns (dict_error, None) or (None, skill_dict)."""
    r = call("GET", "/rest/user-skills/" + quote(name, safe=""), None,
             req["cookie"], req["userAgent"], int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r), None
    return None, r.json()


def op_get(req: dict) -> dict:
    name = req.get("name")
    if not isinstance(name, str) or not name.strip():
        return {"ok": False, "errorClass": "bad_request", "detail": "missing name"}
    err, sk = read_skill(req, name.strip())
    if err:
        return err
    out = summarize(sk)
    out["skillMdContent"] = sk.get("skillMdContent", "")
    return {"ok": True, "skill": out}


def op_verified_published(req: dict) -> dict:
    size = int(req.get("pageSize", 50) or 50)
    r = call("GET", f"/rest/verified-skills/published?pageSize={size}", None,
             req["cookie"], req["userAgent"], int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    j = r.json()
    return {"ok": True, "skills": [summarize(s) for s in (j.get("skills") or [])],
            "nextPageToken": j.get("nextPageToken", "")}


def op_set_enabled(req: dict) -> dict:
    name = req.get("name")
    if not isinstance(name, str) or not name.strip():
        return {"ok": False, "errorClass": "bad_request", "detail": "missing name"}
    if not isinstance(req.get("enabled"), bool):
        return {"ok": False, "errorClass": "bad_request", "detail": "missing enabled bool"}
    name = name.strip()
    want = req["enabled"]
    r = call("POST", "/rest/user-skills/" + quote(name, safe="") + "/enabled",
             {"enabled": want}, req["cookie"], req["userAgent"],
             int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    # Never trust the echo — read back like grok_memory.py does.
    err, sk = read_skill(req, name)
    if err:
        return err
    got = bool(sk.get("enabled", not want))
    return {"ok": True, "name": name, "enabled": got, "persisted": got == want}


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
    ops = {"list": op_list, "search": op_search, "get": op_get,
           "verified_published": op_verified_published, "set_enabled": op_set_enabled}
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
