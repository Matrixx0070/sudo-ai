# Sudo AI Unified Event System

One bus, two consumers. Every platform event is published **once** to the in-process
event bus (`src/core/events/bus.ts`); from there it fans out to:

```
Application code ──publish()──▶ Event Bus ──┬──▶ event log + webhook delivery queue (SQLite)
                                            │         └──▶ Delivery Worker ──▶ signed HTTP POST
                                            └──▶ WebSocket bridge ──▶ realtime push to subscribed clients
```

No Redis/BullMQ/Postgres: sudo-ai is a single-node daemon, so the queue is a
WAL-mode SQLite file (`data/events/events.db`) and the bus is in-process. The
webhook worker and WS push never block the agent loop (CLAUDE.md invariant 3):
`publish()` costs two local SQLite writes; HTTP delivery happens on a background
tick; WS fan-out happens on the next tick.

**Kill switch:** `SUDO_EVENTS=0` disables the whole subsystem (worker, API, bridges).
Worker cadence: `SUDO_EVENTS_TICK_MS` (default 3000).

## Event catalog

Persistent (logged + webhook-eligible): `session.started/updated/idled/terminated`,
`thread.created/updated/deleted`, `message.created/completed/failed`,
`agent.created/updated/archived/deleted`, `deployment.created/updated/paused/unpaused/deleted`,
`deployment_run.started/succeeded/failed`, `memory.created/updated/deleted`,
`tool.started/completed/failed`, `file.uploaded/deleted`, `notification`.

Ephemeral (WS-only, never persisted or webhooked): `session.status`, `session.token`,
`session.output.delta`, `session.output.completed`, `session.error`, `message.delta`,
`agent.typing`, `agent.thinking`, `deployment.logs`, `deployment.status`.

Live now via the progress bridge: session/message/tool lifecycle. Other subsystems
publish with one line:

```ts
import { eventBus } from '../events/index.js';
eventBus.publish('memory.updated', { memory_id, tier }, { channels: [`user:${userId}`] });
```

Subscriptions accept exact names, `prefix.*`, or `*`.

## Webhooks

### Endpoint management (REST, gateway token auth)

Base: `http://127.0.0.1:18900`, auth `Authorization: Bearer $GATEWAY_TOKEN`
(loopback is accepted in dev when no token is configured). Full schema:
`docs/openapi/events.openapi.yaml`. Dashboard: **`/v1/events/dashboard`**
(create/test/rotate/logs/replay/delete).

```bash
# Create (the ONLY response that contains the full signing secret)
curl -s -X POST http://127.0.0.1:18900/v1/webhook-endpoints \
  -H "Authorization: Bearer $GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"CI notifier","url":"https://example.com/hooks/sudo",
       "description":"notify CI","event_types":["message.completed","tool.*"],"retry_max":5}'

curl -s http://127.0.0.1:18900/v1/webhook-endpoints -H "Authorization: Bearer $GATEWAY_TOKEN"   # list (masked)
curl -s -X PATCH  .../v1/webhook-endpoints/<id> -d '{"enabled":false}'                          # pause
curl -s -X POST   .../v1/webhook-endpoints/<id>/rotate-secret                                   # rotate (24h grace)
curl -s -X POST   .../v1/webhook-endpoints/<id>/test                                            # test-fire now
curl -s           .../v1/webhook-endpoints/<id>/deliveries?status=dead                          # DLQ
curl -s -X POST   .../v1/events/deliveries/<delivery_id>/replay                                 # replay
```

### Delivery contract

POST, JSON body:

```json
{ "id": "evt_…", "type": "message.completed", "version": 1,
  "created_at": "2026-07-31T12:00:00.000Z", "data": { "session_id": "…" } }
```

Headers:

| Header | Meaning |
|---|---|
| `X-Sudo-Event` | event type |
| `X-Sudo-Event-Id` | globally unique event id |
| `X-Sudo-Delivery` | delivery attempt group id (stable across retries) |
| `X-Sudo-Idempotency-Key` | dedupe key — process each key at most once |
| `X-Sudo-Timestamp` | unix seconds the request was signed |
| `X-Sudo-Signature` | `v1=<hex hmac-sha256(secret, "<timestamp>.<raw body>")>`; two `v1=` entries during rotation grace |

Any 2xx acknowledges. Anything else (or a >10 s hang, or a redirect) is a failure:
retried with exponential backoff **30s → 2m → 10m → 1h → 6h** (up to `retry_max`
retries, default 5), then parked in the dead-letter queue (`status=dead`) —
inspectable and replayable via API/dashboard. Endpoint URLs are SSRF-guarded
(private/internal addresses refused).

### Verifying signatures (receiver side)

Always verify over the **raw body bytes**, compare constant-time, and reject
timestamps older than ~5 minutes (replay protection).

**Node.js**

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, req, rawBody) {
  const ts = req.headers['x-sudo-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  return req.headers['x-sudo-signature'].split(',').some((part) => {
    const sig = Buffer.from(part.trim().replace(/^v1=/, ''), 'hex');
    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
}
```

**Python**

```python
import hashlib, hmac, time

def verify(secret: str, headers: dict, raw_body: bytes) -> bool:
    ts = headers["X-Sudo-Timestamp"]
    if abs(time.time() - float(ts)) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(p.strip()[3:], expected)
               for p in headers["X-Sudo-Signature"].split(",") if p.strip().startswith("v1="))
```

**Go**

```go
func Verify(secret string, tsHeader, sigHeader string, body []byte) bool {
    ts, err := strconv.ParseInt(tsHeader, 10, 64)
    if err != nil || math.Abs(float64(time.Now().Unix()-ts)) > 300 { return false }
    mac := hmac.New(sha256.New, []byte(secret))
    fmt.Fprintf(mac, "%d.", ts); mac.Write(body)
    expected := hex.EncodeToString(mac.Sum(nil))
    for _, p := range strings.Split(sigHeader, ",") {
        p = strings.TrimPrefix(strings.TrimSpace(p), "v1=")
        if hmac.Equal([]byte(p), []byte(expected)) { return true }
    }
    return false
}
```

**curl** (send a correctly signed test request at your own receiver)

```bash
BODY='{"id":"evt_test","type":"notification","version":1,"created_at":"2026-07-31T00:00:00Z","data":{}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | awk '{print $NF}')
curl -X POST "$RECEIVER_URL" -H 'Content-Type: application/json' \
  -H "X-Sudo-Timestamp: $TS" -H "X-Sudo-Signature: v1=$SIG" -d "$BODY"
```

## WebSocket realtime

Same socket as the gateway RPC server: `ws://127.0.0.1:18900/ws?token=<GATEWAY_TOKEN>`
(JWT-equivalent: the gateway's unified token auth at upgrade; heartbeat ping every
25 s server-side; reconnect by re-dialing and re-subscribing — use `GET /v1/events`
for catch-up, pushed frames carry a per-connection monotonic `seq` so a gap tells
you to refresh).

Methods (JSON-RPC frames `{id, method, params}`):

- `events.subscribe {channels?: string[], types?: string[]}` — channels are rooms:
  `*` (broadcast), `session:<id>`, `user:<id>`, `agent:<id>`, `org:<id>`;
  `types` filters (`message.*`, exact, default all).
- `events.unsubscribe {}`
- `events.presence {}` → `{connections, channels: {name: count}}`

Pushed frame: `{type:'event', event:'<type>', data:<envelope>, seq}`.

**Node.js client**

```js
import WebSocket from 'ws';
const ws = new WebSocket(`ws://127.0.0.1:18900/ws?token=${process.env.GATEWAY_TOKEN}`);
ws.on('open', () => ws.send(JSON.stringify({
  id: '1', method: 'events.subscribe',
  params: { channels: ['session:main'], types: ['message.*', 'tool.*'] },
})));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'event') console.log(msg.seq, msg.event, msg.data.data);
});
```

**Python client**

```python
import asyncio, json, os, websockets

async def main():
    url = f"ws://127.0.0.1:18900/ws?token={os.environ['GATEWAY_TOKEN']}"
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"id": "1", "method": "events.subscribe",
                                  "params": {"channels": ["*"]}}))
        async for raw in ws:
            msg = json.loads(raw)
            if msg.get("type") == "event":
                print(msg["seq"], msg["event"], msg["data"]["data"])

asyncio.run(main())
```

## Operational notes

- **Retention**: events + settled deliveries pruned after 30 days.
- **Idempotency**: the `(endpoint, idempotency_key)` unique index collapses
  re-publishes into one delivery; receivers should also dedupe on
  `X-Sudo-Idempotency-Key`.
- **Versioning**: `version` in the envelope is per-type (catalog.ts); bump it
  when a payload shape changes, never mutate v1 in place.
- **Security**: quarantine still applies — webhook *responses* are discarded,
  never interpreted (invariant 2); endpoint secrets never appear in list/get
  responses or logs; rotation keeps a 24 h dual-signing grace.
