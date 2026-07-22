#!/usr/bin/env python3
"""Grok automations + scheduled tasks — browserless, on the $30 seat.

All lanes are seat-covered, cookie-only and statsig-FREE (proven live
2026-07-21):
  * GET    grok.com/rest/automations           -> {"automations":[Automation]}
  * GET    grok.com/rest/automations/catalog   -> {"groups":[{provider,displayName,
             triggers:[{triggerType,displayName,description,dimensions[],triggerTypeEnum}],providerEnum}]}
  * GET    grok.com/rest/tasks                 -> {"tasks":[],"unreadResults":[],"unreadCounts":[],
             "taskUsage":{"frequentUsage","frequentLimit","occasionalUsage","occasionalLimit"}}
  * GET    grok.com/rest/task/tools            -> {"tools":[{id,label,icon,toolIds,connectorIds}]}
  * POST   grok.com/rest/automations           {content:{name,prompt},triggers:[],schedules:[...]}
             -> Automation {taskId, content{...}, isActive, schedules[], triggers[]}
  * DELETE grok.com/rest/automations/{taskId}  -> {"deleted": true}

NOT wired (probed live 2026-07-21): GET /rest/task-schedules -> 501 "Method Not
Allowed" (it is not a GET surface; the app uses per-automation schedule objects
instead). POST /rest/automations/{id}/run is deliberately NEVER exposed here.

SAFETY (probed live 2026-07-21): the server IGNORES isEnabled:false at create
time — the echoed schedule comes back isEnabled:true, i.e. a created automation
is LIVE immediately. `create` here therefore only accepts a ONE-TIME
(TASK_CADENCE_ONCE) schedule; recurring cadences and connector triggers exist
server-side but are intentionally not exposed through this bridge. Server also
rejects ONCE dates more than 1 year out ("ONCE tasks cannot be scheduled more
than 1 year in the future") and requires timeOfDay ("HH:MM") + dayOfYear
("YYYY-MM-DD").

Contract (mirror grok_memory.py): ONE JSON request on stdin, ONE JSON response
on stdout. Secrets (cookie, userAgent) arrive on stdin ONLY and are never
echoed.

Request:
  {"cookie": "...", "userAgent": "...",
   "op": "list"|"catalog"|"tasks"|"tools"|"create"|"delete",
   # create only:
   "name": "...", "prompt": "...", "dayOfYear": "YYYY-MM-DD",
   "timeOfDay": "HH:MM", "timezone": "UTC",
   # delete only:
   "taskId": "...",
   "timeoutSec": 40}
Response:
  op=list    -> {"ok": true, "automations": [...]}
  op=catalog -> {"ok": true, "groups": [...]}
  op=tasks   -> {"ok": true, "tasks": [...], "taskUsage": {...}}
  op=tools   -> {"ok": true, "tools": [...]}
  op=create  -> {"ok": true, "automation": {taskId, ...}}
  op=delete  -> {"ok": true, "deleted": bool}
  or {"ok": false, "errorClass": "cloudflare|relogin|http_error|bad_request|exception", "detail": "..."}

Needs: curl_cffi. Same-host as the captured session (cf_clearance is IP-bound).
"""
import json
import re
import sys

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


def get_json(path: str, req: dict):
    """GET path; returns (error_dict, None) or (None, parsed_json)."""
    r = call("GET", path, None, req["cookie"], req["userAgent"],
             int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r), None
    return None, r.json()


def op_list(req: dict) -> dict:
    err, j = get_json("/rest/automations", req)
    return err or {"ok": True, "automations": j.get("automations", [])}


def op_catalog(req: dict) -> dict:
    err, j = get_json("/rest/automations/catalog", req)
    return err or {"ok": True, "groups": j.get("groups", [])}


def op_tasks(req: dict) -> dict:
    err, j = get_json("/rest/tasks", req)
    return err or {"ok": True, "tasks": j.get("tasks", []),
                   "taskUsage": j.get("taskUsage", {})}


def op_tools(req: dict) -> dict:
    err, j = get_json("/rest/task/tools", req)
    return err or {"ok": True, "tools": j.get("tools", [])}


def op_create(req: dict) -> dict:
    """Create a ONE-TIME automation (goes LIVE immediately — see module header)."""
    name, prompt = req.get("name"), req.get("prompt")
    day, tod = req.get("dayOfYear"), req.get("timeOfDay", "09:00")
    if not (isinstance(name, str) and name.strip() and isinstance(prompt, str) and prompt.strip()):
        return {"ok": False, "errorClass": "bad_request", "detail": "missing name/prompt"}
    if not (isinstance(day, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", day)):
        return {"ok": False, "errorClass": "bad_request", "detail": "dayOfYear must be YYYY-MM-DD"}
    if not (isinstance(tod, str) and re.fullmatch(r"\d{2}:\d{2}", tod)):
        return {"ok": False, "errorClass": "bad_request", "detail": "timeOfDay must be HH:MM"}
    body = {"content": {"name": name.strip(), "prompt": prompt.strip()},
            "triggers": [],
            "schedules": [{"taskCadence": "TASK_CADENCE_ONCE", "isEnabled": True,
                           "timezone": req.get("timezone", "UTC"),
                           "timeOfDay": tod, "dayOfYear": day}]}
    r = call("POST", "/rest/automations", body, req["cookie"], req["userAgent"],
             int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    return {"ok": True, "automation": r.json()}


def op_delete(req: dict) -> dict:
    tid = req.get("taskId")
    if not (isinstance(tid, str) and re.fullmatch(r"[0-9a-fA-F-]{8,64}", tid)):
        return {"ok": False, "errorClass": "bad_request", "detail": "taskId must be a UUID"}
    r = call("DELETE", f"/rest/automations/{tid}", None,
             req["cookie"], req["userAgent"], int(req.get("timeoutSec", 40)))
    if r.status_code != 200:
        return classify_http(r)
    return {"ok": True, "deleted": r.json().get("deleted", False)}


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
    ops = {"list": op_list, "catalog": op_catalog, "tasks": op_tasks,
           "tools": op_tools, "create": op_create, "delete": op_delete}
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
