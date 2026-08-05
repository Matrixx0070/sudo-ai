"""
Full-fidelity traffic capture addon for mitmproxy.

Captures BOTH directions of everything a browser does against a target host:
HTTP requests + response bodies, and WebSocket frames client->server AND
server->client. Written after six failed attempts to intercept grok.com's chat
send with CDP/Network and in-page fetch hooks — all of which came back empty
because that transport is a WebSocket, not HTTP (see
docs/GROK_WEB_CAPTURE_2026-08-01.md).

Usage:
    mitmdump --set confdir=~/.mitmproxy -s scripts/capture/mitm-capture.py \
             --listen-host 127.0.0.1 -p 8081 -q -w /tmp/flows.mitm

    CAPTURE_HOST=grok.com CAPTURE_OUT=/tmp/capture.jsonl mitmdump ...

Then point a throwaway browser at it:
    google-chrome --user-data-dir=/tmp/cap --proxy-server=127.0.0.1:8081 \
                  --ignore-certificate-errors --test-type --disable-quic

To get a LOGGED-IN throwaway profile, copy only `Local State` and
`Default/Cookies` from the real profile (~500 KB). Cloning a full Chrome profile
can be gigabytes and will get the process OOM-killed.

Output is JSONL, one event per line, so it greps and jq's cleanly.
"""

import json
import os
from mitmproxy import http

HOST = os.environ.get("CAPTURE_HOST", "grok.com")
OUT = os.environ.get("CAPTURE_OUT", "/tmp/capture.jsonl")
MAX = int(os.environ.get("CAPTURE_MAX_BYTES", "30000"))

# Telemetry/ad noise that drowns the signal. Everything else is kept.
NOISE = ("log_metric", "/_data/", "cdn-cgi", "/monitoring?", "sentry",
         "google.com/ccm", "googleadservices", "appsflyer", "/rmkt/")

# Header allowlist — never capture Cookie or Authorization.
KEEP_HEADERS = ("content-type", "x-statsig-id", "x-xai-request-id",
                "x-client-request-id", "baggage", "upgrade")


def _skip(url: str) -> bool:
    return HOST not in url or any(n in url for n in NOISE)


def _write(rec: dict) -> None:
    with open(OUT, "a") as f:
        f.write(json.dumps(rec) + "\n")


def _headers(msg) -> dict:
    return {k.lower(): v[:120] for k, v in msg.headers.items()
            if k.lower() in KEEP_HEADERS}


def _text(msg) -> str:
    try:
        return (msg.get_text(strict=False) or "")[:MAX]
    except Exception:
        return "<binary %d bytes>" % len(msg.raw_content or b"")


def request(flow: http.HTTPFlow) -> None:
    if _skip(flow.request.pretty_url):
        return
    _write({"kind": "req", "method": flow.request.method,
            "url": flow.request.pretty_url.replace("https://" + HOST, ""),
            "hdrs": _headers(flow.request), "body": _text(flow.request)})


def response(flow: http.HTTPFlow) -> None:
    if _skip(flow.request.pretty_url):
        return
    _write({"kind": "res", "status": flow.response.status_code,
            "url": flow.request.pretty_url.replace("https://" + HOST, ""),
            "hdrs": _headers(flow.response), "body": _text(flow.response)})


def websocket_start(flow) -> None:
    _write({"kind": "ws_open", "url": flow.request.pretty_url})


def websocket_message(flow) -> None:
    m = flow.websocket.messages[-1]
    _write({"kind": "ws_tx" if m.from_client else "ws_rx",
            "url": flow.request.pretty_url,
            "content": m.content.decode("utf-8", "replace")[:MAX]})


def websocket_end(flow) -> None:
    _write({"kind": "ws_close", "url": flow.request.pretty_url,
            "frames": len(flow.websocket.messages)})
