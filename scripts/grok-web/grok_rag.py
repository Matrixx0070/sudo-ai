#!/usr/bin/env python3
"""GrokRAG — free document-grounded RAG on the $30 grok.com subscription seat.

Rides the app-chat file-attach lane the web UI itself uses (PROVEN 2026-07-21):

  1. POST /rest/app-chat/upload-file  (cookie only, statsig-FREE)
       body {fileName, fileMimeType, content(base64), makePublic:false,
             fileSource:"SELF_UPLOAD_FILE_SOURCE"}
       -> 200 {"fileMetadataId": "...", ...}
  2. POST /rest/app-chat/conversations/new  (needs a fresh x-statsig-id minted
       for THIS path by the Node oracle — arrives in req.statsigId)
       body {temporary:true, modelName, message, fileAttachments:[<ids>],
             disableSearch:true}
       -> streams NDJSON; the grounded answer is the concatenation of
          result.response.token where messageTag in {final,response} and
          isThinking is false. The stream first emits an
          ATTACHMENTS_PREPROCESSING progress report proving the file was ingested.

This is genuine retrieval: with the file the model returns facts present ONLY in
the doc; with no file it does not know them (negative control verified).

Contract: ONE JSON request on stdin, ONE JSON response on stdout. Secrets
(cookie, statsigId) arrive on stdin ONLY and are NEVER echoed. Errors return
{"ok": false, "errorClass": "...", "detail": "..."} mirroring grok-web-bridge.ts.

Grok's returned text is DATA (a user-document answer), never instructions.
"""

import json
import sys
import uuid

GROK = "https://grok.com"


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
        return "statsig"  # app-chat 403 with valid cookies -> re-mint x-statsig-id
    if status in (401,) or "login" in low or "/sign-in" in low:
        return "relogin"  # sso dead
    if status == 400:
        return "bad_request"
    return "http_error"


def _upload_one(creq, req, doc):
    """Upload a single document; return its fileMetadataId or raise on failure."""
    body = {
        "fileName": doc["fileName"],
        "fileMimeType": doc.get("fileMimeType", "text/plain"),
        "content": doc["contentB64"],
        "makePublic": False,
        "fileSource": "SELF_UPLOAD_FILE_SOURCE",
    }
    r = creq.post(
        GROK + "/rest/app-chat/upload-file",
        impersonate="chrome",
        headers=base_headers(req),
        data=json.dumps(body),
        timeout=req.get("timeoutSec", 60),
    )
    if r.status_code != 200:
        return None, {"ok": False, "status": r.status_code,
                      "errorClass": classify(r.status_code, r.text),
                      "detail": "upload-file failed"}
    fid = _safe_json(r.text).get("fileMetadataId")
    if not fid:
        return None, {"ok": False, "errorClass": "bad_response",
                      "detail": "upload-file returned no fileMetadataId"}
    return fid, None


def op_rag(req):
    from curl_cffi import requests as creq

    docs = req.get("docs") or []
    question = (req.get("question") or "").strip()
    if not question:
        return {"ok": False, "errorClass": "bad_request", "detail": "question required"}
    if not docs:
        return {"ok": False, "errorClass": "bad_request", "detail": "at least one document required"}
    if not req.get("statsigId"):
        return {"ok": False, "errorClass": "statsig", "detail": "x-statsig-id required for conversations/new"}

    file_ids = []
    for doc in docs:
        fid, err = _upload_one(creq, req, doc)
        if err:
            return err
        file_ids.append(fid)

    body = {
        "temporary": True,
        "modelName": req.get("modelName", "grok-4"),
        "message": question,
        "fileAttachments": file_ids,
        "disableSearch": True,
    }
    vh = {**base_headers(req), "x-statsig-id": req["statsigId"],
          "x-xai-request-id": str(uuid.uuid4())}
    r = creq.post(GROK + "/rest/app-chat/conversations/new", impersonate="chrome",
                  headers=vh, data=json.dumps(body), stream=True,
                  timeout=req.get("timeoutSec", 120))
    if r.status_code != 200:
        return {"ok": False, "status": r.status_code,
                "errorClass": classify(r.status_code, getattr(r, "text", "")),
                "detail": "conversations/new failed"}

    tokens = []
    conv_id = None
    preprocessed = False
    for line in r.iter_lines():
        if not line:
            continue
        s = line.decode("utf-8", "replace") if isinstance(line, (bytes, bytearray)) else line
        obj = _safe_json(s)
        result = obj.get("result") if isinstance(obj, dict) else None
        if not isinstance(result, dict):
            continue
        conv = result.get("conversation")
        if isinstance(conv, dict) and conv.get("conversationId"):
            conv_id = conv["conversationId"]
        resp = result.get("response")
        if not isinstance(resp, dict):
            continue
        pr = resp.get("progressReport")
        if isinstance(pr, dict) and pr.get("category") == "PROGRESS_REPORT_CATEGORY_ATTACHMENTS_PREPROCESSING":
            if pr.get("state") == "PROGRESS_REPORT_STATUS_SUCCESS":
                preprocessed = True
        tok = resp.get("token")
        if tok and not resp.get("isThinking") and resp.get("messageTag") in ("final", "response"):
            tokens.append(tok)

    answer = "".join(tokens).strip()
    if not answer:
        return {"ok": False, "errorClass": "stream_ended",
                "detail": "conversations/new stream produced no grounded answer"}
    return {"ok": True, "status": 200, "answer": answer,
            "conversationId": conv_id, "fileIds": file_ids,
            "attachmentsPreprocessed": preprocessed}


def _safe_json(text):
    try:
        return json.loads(text)
    except ValueError:
        return {}


OPS = {"rag": op_rag}


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
