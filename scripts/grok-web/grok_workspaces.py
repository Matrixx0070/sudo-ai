#!/usr/bin/env python3
"""Grok workspaces (READ-ONLY) — browserless, on the $30 seat.

All lanes are seat-covered, cookie-only and statsig-FREE (probed live
2026-07-22 — list/shared return 200; every per-id reader answers with a clean
404 "Workspace not found or access denied" for unknown ids, proving GET is the
accepted method and the cookie authenticates):

  * GET /rest/workspaces?pageSize&pageToken&orderBy
        -> {"workspaces": [Workspace], "nextPageToken"?}
  * GET /rest/workspaces/shared (same query + shape)
  * GET /rest/workspaces/{id}
        -> Workspace {workspaceId,name,createTime,lastUseTime,icon,
           customPersonality,preferredModel,isPublic,isReadonly,accessLevel,...}
  * GET /rest/workspaces/{id}/files?path&recursive
        -> {"files": [{path,name,isDirectory,size,mimeType,createdAt,
            modifiedAt,assetId}], "path"?}
  * GET /rest/workspaces/{id}/files/content?path
        -> {signedUrl?, downloadSignedUrl?, expiresAt?, mimeType?, size?}
  * GET /rest/workspaces/{id}/computer-root/access -> {state?, provider?}
  * GET /rest/workspaces/{id}/connectors  -> {"connectorIds": [...]}
  * GET /rest/workspaces/{id}/collections -> {"collectionIds": [...]}
  * GET /rest/workspaces/{id}/permissions -> {"permissions": {...}}

(All shapes cross-checked against the grok.com app bundle's
workspaceRepository* client, harvested 2026-07-22.)

NOT wired (write surface, deliberately untouched — V1 is READ-ONLY):
POST /rest/workspaces (create), PATCH/DELETE /rest/workspaces/{id},
POST {id}/files/{upload,mkdir,move}, DELETE {id}/files,
POST {id}/computer-root (set root), POST {id}/{conversations,connectors,
collections,permissions/*,share,clone}. GET {id}/conversations and a bare GET
{id}/computer-root both 501 (those paths are POST-only mutators).

Contract (mirror grok_memory.py): ONE JSON request on stdin, ONE JSON response
on stdout. Secrets (cookie, userAgent) arrive on stdin ONLY, never echoed.

Request:
  {"cookie": "...", "userAgent": "...",
   "op": "list"|"detail"|"files"|"file_content",
   "shared": false,             # list only: use /rest/workspaces/shared
   "pageSize": 50, "pageToken": "...",   # list only, optional
   "workspaceId": "...",        # detail/files/file_content
   "path": "...",               # files (optional) / file_content (required)
   "recursive": false,          # files only
   "download": false,           # file_content: also fetch the signed URL bytes
   "timeoutSec": 40}
Response:
  op=list         -> {"ok": true, "workspaces": [...], "nextPageToken": "..."}
  op=detail       -> {"ok": true, "workspace": {...}, "connectorIds": [...],
                      "collectionIds": [...], "permissions": {...}|null,
                      "computerRoot": {"state":..., "provider":...}|null}
  op=files        -> {"ok": true, "files": [...], "path": "..."}
  op=file_content -> {"ok": true, "content": {signedUrl,...},
                      "contentB64": "..."}   # only when download:true
  or {"ok": false, "errorClass": "cloudflare|relogin|http_error|bad_request|
      not_found|bad_response|exception", "detail": "..."}

DOWNLOAD SAFETY: when download:true the signed URL host must be grok.com or a
*.grok.com subdomain (assets host) — anything else is rejected as
bad_response (blocks SSRF/redirect games via a hostile signedUrl). Bytes ride
back base64; the Node caller decides (and confines) any disk write.

Needs: curl_cffi. Same-host as the captured session (cf_clearance is IP-bound).
"""
import json
import re
import sys
from urllib.parse import urlparse

GROK = "https://grok.com"
UUID_RE = re.compile(r"^[0-9a-fA-F-]{32,40}$")


def call(path: str, query, cookie: str, ua: str, timeout: int):
    from curl_cffi import requests as creq
    H = {"User-Agent": ua, "Cookie": cookie, "Origin": GROK, "Referer": GROK + "/",
         "Content-Type": "application/json"}
    return creq.get(GROK + path, impersonate="chrome", headers=H,
                    params=query or None, timeout=timeout)


def classify_http(r) -> dict:
    """Structured non-2xx handling. Never includes cookie material."""
    text = r.text or ""
    if r.status_code == 403 and "just a moment" in text[:500].lower():
        return {"ok": False, "status": r.status_code, "errorClass": "cloudflare",
                "detail": "Cloudflare challenge — refresh cf_clearance/__cf_bm"}
    if r.status_code == 401 or (r.status_code == 403 and "sign-in" in text[:500].lower()):
        return {"ok": False, "status": r.status_code, "errorClass": "relogin",
                "detail": "grok session dead — re-provision websession"}
    if r.status_code == 404:
        return {"ok": False, "status": 404, "errorClass": "not_found",
                "detail": f"HTTP 404: {text[:200]}"}
    return {"ok": False, "status": r.status_code, "errorClass": "http_error",
            "detail": f"HTTP {r.status_code}: {text[:300]}"}


def require_wid(req: dict):
    wid = (req.get("workspaceId") or "").strip()
    if not wid or not UUID_RE.match(wid):
        return None
    return wid


def op_list(req: dict) -> dict:
    q = {}
    if req.get("pageSize"):
        q["pageSize"] = int(req["pageSize"])
    if req.get("pageToken"):
        q["pageToken"] = str(req["pageToken"])
    path = "/rest/workspaces/shared" if req.get("shared") else "/rest/workspaces"
    r = call(path, q, req["cookie"], req["userAgent"], int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    body = r.json()
    return {"ok": True, "workspaces": body.get("workspaces", []),
            "nextPageToken": body.get("nextPageToken", "")}


def op_detail(req: dict) -> dict:
    wid = require_wid(req)
    if not wid:
        return {"ok": False, "errorClass": "bad_request", "detail": "valid workspaceId required"}
    t = int(req.get("timeoutSec", 40))
    r = call(f"/rest/workspaces/{wid}", None, req["cookie"], req["userAgent"], t)
    if r.status_code != 200:
        return classify_http(r)
    out = {"ok": True, "workspace": r.json(), "connectorIds": [],
           "collectionIds": [], "permissions": None, "computerRoot": None}
    # Best-effort side reads — each verified GET-able live; a non-200 on one
    # never fails the whole detail (it just stays empty/null).
    for path, fn in ((f"/rest/workspaces/{wid}/connectors",
                      lambda b: out.update(connectorIds=b.get("connectorIds", []))),
                     (f"/rest/workspaces/{wid}/collections",
                      lambda b: out.update(collectionIds=b.get("collectionIds", []))),
                     (f"/rest/workspaces/{wid}/permissions",
                      lambda b: out.update(permissions=b.get("permissions"))),
                     (f"/rest/workspaces/{wid}/computer-root/access",
                      lambda b: out.update(computerRoot=b))):
        rr = call(path, None, req["cookie"], req["userAgent"], t)
        if rr.status_code == 200:
            fn(rr.json())
    return out


def op_files(req: dict) -> dict:
    wid = require_wid(req)
    if not wid:
        return {"ok": False, "errorClass": "bad_request", "detail": "valid workspaceId required"}
    q = {}
    if req.get("path"):
        q["path"] = str(req["path"])
    if req.get("recursive"):
        q["recursive"] = "true"
    r = call(f"/rest/workspaces/{wid}/files", q, req["cookie"], req["userAgent"],
             int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    body = r.json()
    return {"ok": True, "files": body.get("files", []), "path": body.get("path", "")}


def op_file_content(req: dict) -> dict:
    wid = require_wid(req)
    if not wid:
        return {"ok": False, "errorClass": "bad_request", "detail": "valid workspaceId required"}
    p = (req.get("path") or "").strip()
    if not p:
        return {"ok": False, "errorClass": "bad_request", "detail": "path required"}
    r = call(f"/rest/workspaces/{wid}/files/content", {"path": p},
             req["cookie"], req["userAgent"], int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    content = r.json()
    out = {"ok": True, "content": content}
    if req.get("download"):
        url = content.get("downloadSignedUrl") or content.get("signedUrl") or ""
        host = urlparse(url).hostname or ""
        # Host allow-list: only grok.com / *.grok.com signed URLs are fetched.
        if urlparse(url).scheme != "https" or not (host == "grok.com" or host.endswith(".grok.com")):
            return {"ok": False, "errorClass": "bad_response",
                    "detail": f"signed URL host not allow-listed: {host or '(none)'}"}
        from curl_cffi import requests as creq
        rr = creq.get(url, impersonate="chrome",
                      headers={"User-Agent": req["userAgent"]},
                      timeout=int(req.get("timeoutSec", 120)))
        if rr.status_code != 200:
            return classify_http(rr)
        import base64
        out["contentB64"] = base64.b64encode(rr.content).decode("ascii")
    return out


OPS = {"list": op_list, "detail": op_detail, "files": op_files,
       "file_content": op_file_content}


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
    fn = OPS.get(req["op"])
    if fn is None:
        print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"unknown op {req['op']!r}"}))
        return
    try:
        print(json.dumps(fn(req)))
    except Exception as e:  # never leak secrets
        print(json.dumps({"ok": False, "errorClass": "exception", "detail": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
