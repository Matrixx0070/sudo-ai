# Unified Gateway (Wave 3 — single-port)

Frank's directive: all traffic on one port. The gateway server (default port 18900) is the sole
listener for every user-facing concern: web chat HTML, REST message injection, chat WebSocket,
admin REST, agent JSON-RPC WebSocket, skill registry, and the OpenAI-compatible completions
passthrough. `WebAdapter.attach(server)` registers its HTTP and WebSocket listeners directly on
the already-running gateway `http.Server`; no second port is opened.

---

## Port Reference

| Port  | Process          | Audience        | Notes                                                   |
|-------|------------------|-----------------|---------------------------------------------------------|
| 18900 | gateway (cli.ts) | All users/admin | Every user-facing and admin endpoint lives here         |
| 3003  | claude-proxy     | Internal only   | Loopback Anthropic API shim — NOT user-facing; separate concern |

---

## Endpoint Map — :18900

### Health

| Method | Path      | Description              |
|--------|-----------|--------------------------|
| GET    | /health   | Liveness check; returns `{"ok":true}` |

### Web Chat

| Method    | Path        | Description                                              |
|-----------|-------------|----------------------------------------------------------|
| GET       | /chat       | Serves chat HTML UI (WEB_CHAT_TOKEN gate if configured)  |
| POST      | /api/message| REST message injection: `{"peerId":"...","text":"..."}` (WEB_CHAT_TOKEN gate) |
| WebSocket | /chat/ws    | Real-time browser chat (WEB_CHAT_TOKEN gate if configured) |

### Agent / Admin WebSocket

| Method    | Path | Description                              |
|-----------|------|------------------------------------------|
| WebSocket | /ws  | JSON-RPC agent and admin control channel (existing; unchanged) |

### Admin REST

| Method | Path                          | Description                    |
|--------|-------------------------------|--------------------------------|
| GET    | /v1/admin/digest              | Unified telemetry digest        |
| GET    | /v1/admin/alignment           | Alignment aggregator state      |
| GET    | /v1/admin/veto/threshold      | Auto-tuned veto threshold       |
| GET    | /v1/admin/dashboard           | HTML alignment dashboard        |
| GET    | /v1/admin/trust               | Trust tier tracker state        |
| GET    | /v1/admin/patterns            | Mistake pattern recognizer      |
| GET    | /v1/admin/calibration         | Confidence calibration (Brier)  |
| GET    | /v1/admin/diagnostics         | Cross-signal diagnostics        |
| GET    | /v1/admin/injection/stats     | Injection detector statistics   |
| GET    | /v1/admin/reanchor/stats      | Re-anchor monitor statistics    |
| GET    | /v1/admin/reanchor/recent     | Recent re-anchor events         |
| GET    | /v1/admin/epistemic/log       | Epistemic gate log              |
| POST   | /v1/admin/commitments/resolve | Resolve a tracked commitment    |
| GET    | /v1/admin/compare             | Side-by-side route compare      |

### Skill Registry

| Method | Path                        | Description                     |
|--------|-----------------------------|---------------------------------|
| GET    | /v1/registry/skills         | List all published skills       |
| GET    | /v1/registry/skills/:id     | Single skill (JSON)             |
| GET    | /v1/registry/skills/:id/raw | Single skill (raw Markdown)     |

### OpenAI-Compatible Completions

| Method | Path                   | Description                                                |
|--------|------------------------|------------------------------------------------------------|
| POST   | /v1/chat/completions   | Proxied to SUDOAPI upstream — not handled locally          |
| GET    | /v1/models             | Model list passthrough                                     |

### Federation

| Method | Path                      | Description                     |
|--------|---------------------------|---------------------------------|
| GET    | /v1/federation/peers      | List registered federation peers |
| POST   | /v1/federation/sync       | Trigger audit-chain pull        |
| GET    | /v1/federation/audit      | Federated audit chain view      |
| POST   | /v1/federation/publish    | Publish local re-anchor event   |

---

## curl Examples

```bash
# Liveness check
curl -s http://127.0.0.1:18900/health

# Fetch chat HTML (first 40 bytes)
curl -s http://127.0.0.1:18900/chat | head -c 40

# Admin digest (requires SUDO_AI_DASHBOARD_TOKEN)
curl -s http://127.0.0.1:18900/v1/admin/digest \
  -H "Authorization: Bearer $SUDO_AI_DASHBOARD_TOKEN" | head -c 200

# REST message injection
curl -s -X POST http://127.0.0.1:18900/api/message \
  -H "Content-Type: application/json" \
  -d '{"peerId":"test","text":"hello"}'

# WebSocket — JSON-RPC admin channel (existing, unchanged)
wscat -c ws://127.0.0.1:18900/ws

# WebSocket — browser chat channel
wscat -c ws://127.0.0.1:18900/chat/ws
```

---

## Migration Note

The `WEB_CHAT_PORT` environment variable is now ignored. Existing deployments that previously
accessed web chat on port 3004 (or 3001/3002 in older configs) should update browser bookmarks
and reverse-proxy configurations to point to `http://<host>:18900/chat`. The WebSocket endpoint
moves from `ws://<host>:<WEB_CHAT_PORT>/ws` to `ws://<host>:18900/chat/ws`. The existing
JSON-RPC WebSocket at `ws://<host>:18900/ws` is unaffected.
