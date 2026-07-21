#!/usr/bin/env python3
"""GrokFiles — free file upload + management on the $30 grok.com subscription seat.

Rides the app-chat file lane the web UI itself uses. ALL ops here are
cookie-only, statsig-FREE (PROVEN LIVE 2026-07-21):

  upload   POST /rest/app-chat/upload-file
             body {fileName, fileMimeType, content(base64), makePublic:false,
                   fileSource:"SELF_UPLOAD_FILE_SOURCE"}
             -> 200 {fileMetadataId, fileMimeType, fileName, fileUri,
                     parsedFileUri, createTime, fileSource}
  get      POST /rest/app-chat/file-metadata/{fileMetadataId}
             -> 200 same FileMetadata shape; 404 {"code":5} on unknown id
  download GET  https://assets.grok.com/{fileUri}   (cookie-only)
             -> 200 raw file bytes (returned here as base64)

Storage is PERSISTENT + user-scoped (fileUri = users/{userId}/{fileId}/content);
the fileMetadataId is reusable across chats as a `fileAttachments` entry.
HONEST LIMITS (probed live, do not fake): there is NO list-my-uploads endpoint
and NO delete endpoint on the seat (DELETE file-metadata -> 501 Method Not
Allowed; POST /rest/app-chat/delete-file -> 404). /rest/conversations/files/*
is a different, conversation-workspace service (400 without conversation_id).

Contract: ONE JSON request on stdin, ONE JSON response on stdout. Secrets
(cookie, userAgent) arrive on stdin ONLY and are NEVER echoed. Errors return
{"ok": false, "errorClass": "...", "detail": "..."} mirroring grok-web-bridge.ts.
"""

import json
import re
import sys

GROK = "https://grok.com"
ASSETS = "https://assets.grok.com"
UUID_RE = re.compile(r"^[0-9a-fA-F-]{32,40}$")
# fileUri comes back from grok's own metadata; still constrain it so a corrupt
# value can never traverse into an arbitrary URL path.
FILE_URI_RE = re.compile(r"^users/[0-9a-zA-Z/_.-]+$")


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
        return "forbidden"
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


def _metadata(obj):
    """Project grok's FileMetadata onto the fields we surface (no extras)."""
    return {k: obj.get(k) for k in (
        "fileMetadataId", "fileName", "fileMimeType", "fileUri",
        "parsedFileUri", "createTime", "fileSource")}


def op_upload(req):
    from curl_cffi import requests as creq

    file_name = (req.get("fileName") or "").strip()
    content_b64 = req.get("contentB64") or ""
    if not file_name or not content_b64:
        return {"ok": False, "errorClass": "bad_request",
                "detail": "fileName and contentB64 required"}
    body = {
        "fileName": file_name,
        "fileMimeType": req.get("fileMimeType", "application/octet-stream"),
        "content": content_b64,
        "makePublic": False,
        "fileSource": "SELF_UPLOAD_FILE_SOURCE",
    }
    r = creq.post(GROK + "/rest/app-chat/upload-file", impersonate="chrome",
                  headers=base_headers(req), data=json.dumps(body),
                  timeout=req.get("timeoutSec", 60))
    if r.status_code != 200:
        return _http_fail(r, "upload-file failed")
    meta = _metadata(_safe_json(r.text))
    if not meta.get("fileMetadataId"):
        return {"ok": False, "errorClass": "bad_response",
                "detail": "upload-file returned no fileMetadataId"}
    return {"ok": True, "status": 200, "file": meta}


def _get_metadata(creq, req, fid):
    r = creq.post(GROK + "/rest/app-chat/file-metadata/" + fid,
                  impersonate="chrome", headers=base_headers(req),
                  data="{}", timeout=req.get("timeoutSec", 60))
    if r.status_code != 200:
        return None, _http_fail(r, "file-metadata failed")
    return _metadata(_safe_json(r.text)), None


def _require_fid(req):
    fid = (req.get("fileMetadataId") or "").strip()
    if not fid or not UUID_RE.match(fid):
        return None
    return fid


def op_get(req):
    from curl_cffi import requests as creq

    fid = _require_fid(req)
    if not fid:
        return {"ok": False, "errorClass": "bad_request",
                "detail": "valid fileMetadataId required"}
    meta, err = _get_metadata(creq, req, fid)
    return err if err else {"ok": True, "status": 200, "file": meta}


def op_download(req):
    from curl_cffi import requests as creq

    fid = _require_fid(req)
    if not fid:
        return {"ok": False, "errorClass": "bad_request",
                "detail": "valid fileMetadataId required"}
    meta, err = _get_metadata(creq, req, fid)
    if err:
        return err
    uri = meta.get("fileUri") or ""
    if not FILE_URI_RE.match(uri) or ".." in uri:
        return {"ok": False, "errorClass": "bad_response",
                "detail": "file-metadata returned an unexpected fileUri shape"}
    r = creq.get(ASSETS + "/" + uri, impersonate="chrome",
                 headers=base_headers(req), timeout=req.get("timeoutSec", 120))
    if r.status_code != 200:
        return _http_fail(r, "assets download failed")
    import base64
    return {"ok": True, "status": 200, "file": meta,
            "contentB64": base64.b64encode(r.content).decode("ascii")}


OPS = {"upload": op_upload, "get": op_get, "download": op_download}


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
