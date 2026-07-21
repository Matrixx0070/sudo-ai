#!/usr/bin/env python3
"""Grok managed-embedding RAG collections — statsig-free, on the $30 seat.

grok.com exposes a managed vector/RAG service under
`/rest/grok-for-teams/collections/*`. Documents are chunked + embedded
SERVER-SIDE (pick an embedding model from `/rest/grok-for-teams/embedding-models`).
These endpoints authenticate with cookies ONLY — no `x-statsig-id` (proven live
2026-07-21), unlike the video / app-chat lanes.

IMPORTANT (verified live 2026-07-21): there is NO statsig-free RETRIEVAL endpoint.
The semantic query ("give me relevant chunks") is only reachable through the
statsig-gated `/rest/app-chat/conversations/new` `collectionsSearch` tool
(returns HTTP 403 grpc-code-7 "Request rejected by anti-bot rules" without a
minted x-statsig-id). This bridge therefore ships the statsig-free MANAGEMENT +
INGEST half only: model catalog, create/list/delete collections, add/list
documents, poll indexing. Retrieval is intentionally out of scope here.

Contract (mirror grok_web_replay.py): ONE JSON request on stdin, ONE JSON
response on the last stdout line. Secrets (`cookie`, `userAgent`) arrive on
stdin ONLY and are NEVER echoed/logged.

Ops (field `op`):
  models                       -> {ok, models:[...], chunkConfigEditable}
  create   {name, model?}      -> {ok, collectionId, collectionName, modelName}
  list                         -> {ok, collections:[{collectionId, collectionName, ...}]}
  delete   {collectionId}      -> {ok}
  add_doc  {collectionId, docName, contentBase64, contentType?}
                               -> {ok, fileId, processingStatus}
  list_docs {collectionId}     -> {ok, documents:[{fileId, name, status, chunksProcessedCount, ...}]}
  metadata {collectionId}      -> {ok, collectionId, documentsCount, modelName, ...}

On any failure emits {ok:false, errorClass, detail} mirroring
src/llm/grok-embeddings-bridge.ts (cloudflare|relogin|http_error|bad_request|
grpc_not_found|timeout|exception).

Needs: curl_cffi. Same-host as the captured session (cf_clearance is IP-bound).
"""
import json
import sys

GROK = "https://grok.com"
BASE = "/rest/grok-for-teams/collections"
DEFAULT_MODEL = "grok-embedding-small"


def _headers(cookie: str, ua: str) -> dict:
    return {
        "User-Agent": ua,
        "Cookie": cookie,
        "Origin": GROK,
        "Referer": GROK + "/",
        "Content-Type": "application/json",
    }


def _classify(status: int, text: str) -> str:
    low = text[:200].lower()
    if status in (401,) or "sign-in" in low or "log in" in low:
        return "relogin"
    if status == 403 and "just a moment" in low:
        return "cloudflare"
    if status == 403:
        # grpc code 7 anti-bot (statsig lane) or plain forbidden
        return "http_error"
    if status == 404:
        return "grpc_not_found"
    if 400 <= status < 500:
        return "bad_request"
    return "http_error"


def _request(method: str, path: str, cookie: str, ua: str, body=None, timeout: int = 60):
    """Return (status, parsed_json_or_None, raw_text). Raises for transport errors."""
    from curl_cffi import requests as creq

    h = _headers(cookie, ua)
    url = GROK + path
    kw = {"impersonate": "chrome", "headers": h, "timeout": timeout}
    if body is not None:
        kw["data"] = json.dumps(body)
    r = creq.request(method, url, **kw)
    try:
        parsed = r.json()
    except ValueError:
        parsed = None
    return r.status_code, parsed, r.text


def _fail(status: int, text: str) -> dict:
    return {"ok": False, "status": status, "errorClass": _classify(status, text),
            "detail": text[:300]}


def op_models(req, cookie, ua, tmo):
    st, j, tx = _request("GET", "/rest/grok-for-teams/embedding-models", cookie, ua, timeout=tmo)
    if st != 200 or j is None:
        return _fail(st, tx)
    return {"ok": True, "status": st, "models": j.get("embeddingModels", []),
            "chunkConfigEditable": bool(j.get("chunkConfigEditable"))}


def op_create(req, cookie, ua, tmo):
    name = req.get("name")
    if not name:
        return {"ok": False, "errorClass": "bad_request", "detail": "missing name"}
    model = req.get("model") or DEFAULT_MODEL
    body = {"collectionName": name, "indexConfiguration": {"modelName": model}}
    st, j, tx = _request("POST", BASE, cookie, ua, body=body, timeout=tmo)
    if st != 200 or j is None:
        return _fail(st, tx)
    return {"ok": True, "status": st, "collectionId": j.get("collectionId"),
            "collectionName": j.get("collectionName"),
            "modelName": (j.get("indexConfiguration") or {}).get("modelName")}


def op_list(req, cookie, ua, tmo):
    st, j, tx = _request("GET", BASE, cookie, ua, timeout=tmo)
    if st != 200 or j is None:
        return _fail(st, tx)
    cols = []
    for c in j.get("collections", []) or []:
        cols.append({
            "collectionId": c.get("collectionId"),
            "collectionName": c.get("collectionName"),
            "createdAt": c.get("createdAt"),
            "documentsCount": c.get("documentsCount"),
            "modelName": (c.get("indexConfiguration") or {}).get("modelName"),
        })
    return {"ok": True, "status": st, "collections": cols}


def op_delete(req, cookie, ua, tmo):
    cid = req.get("collectionId")
    if not cid:
        return {"ok": False, "errorClass": "bad_request", "detail": "missing collectionId"}
    st, _j, tx = _request("DELETE", f"{BASE}/{cid}", cookie, ua, timeout=tmo)
    if st != 200:
        return _fail(st, tx)
    return {"ok": True, "status": st}


def op_metadata(req, cookie, ua, tmo):
    cid = req.get("collectionId")
    if not cid:
        return {"ok": False, "errorClass": "bad_request", "detail": "missing collectionId"}
    st, j, tx = _request("GET", f"{BASE}/{cid}/metadata", cookie, ua, timeout=tmo)
    if st != 200 or j is None:
        return _fail(st, tx)
    return {"ok": True, "status": st, "collectionId": j.get("collectionId"),
            "collectionName": j.get("collectionName"),
            "documentsCount": j.get("documentsCount"),
            "modelName": (j.get("indexConfiguration") or {}).get("modelName")}


def op_add_doc(req, cookie, ua, tmo):
    cid = req.get("collectionId")
    doc_name = req.get("docName")
    content_b64 = req.get("contentBase64")
    if not cid or not doc_name or not content_b64:
        return {"ok": False, "errorClass": "bad_request",
                "detail": "missing collectionId/docName/contentBase64"}
    body = {"name": doc_name, "data": content_b64,
            "contentType": req.get("contentType") or "text/plain"}
    st, j, tx = _request("POST", f"{BASE}/{cid}/documents", cookie, ua, body=body, timeout=tmo)
    if st != 200 or j is None:
        return _fail(st, tx)
    fm = j.get("fileMetadata") or {}
    return {"ok": True, "status": st, "fileId": fm.get("fileId"),
            "docName": fm.get("name"), "sizeBytes": fm.get("sizeBytes"),
            "processingStatus": fm.get("processingStatus"),
            "documentStatus": j.get("status")}


def op_list_docs(req, cookie, ua, tmo):
    cid = req.get("collectionId")
    if not cid:
        return {"ok": False, "errorClass": "bad_request", "detail": "missing collectionId"}
    st, j, tx = _request("GET", f"{BASE}/{cid}/documents", cookie, ua, timeout=tmo)
    if st != 200 or j is None:
        return _fail(st, tx)
    docs = []
    for d in j.get("documents", []) or []:
        fm = d.get("fileMetadata") or {}
        docs.append({
            "fileId": fm.get("fileId"),
            "name": fm.get("name"),
            "sizeBytes": fm.get("sizeBytes"),
            "processingStatus": fm.get("processingStatus"),
            "status": d.get("status"),
            "chunksProcessedCount": d.get("chunksProcessedCount"),
            "lastIndexedAt": d.get("lastIndexedAt"),
        })
    return {"ok": True, "status": st, "documents": docs}


OPS = {
    "models": op_models,
    "create": op_create,
    "list": op_list,
    "delete": op_delete,
    "metadata": op_metadata,
    "add_doc": op_add_doc,
    "list_docs": op_list_docs,
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
    op = req["op"]
    handler = OPS.get(op)
    if handler is None:
        print(json.dumps({"ok": False, "errorClass": "bad_request", "detail": f"unknown op: {op}"}))
        return
    tmo = int(req.get("timeoutSec", 60))
    try:
        result = handler(req, req["cookie"], req["userAgent"], tmo)
    except Exception as e:  # never leak secrets
        result = {"ok": False, "errorClass": "exception", "detail": f"{type(e).__name__}: {e}"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
