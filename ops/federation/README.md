# SUDO-AI v5 — Federation Operator Guide

Wave 8C — federation cross-instance handshake proof.

## Overview

Federation allows two or more SUDO-AI v5 instances to cross-publish audit events. When
instance A triggers a re-anchor (or any instrumented federation hook), it fires an HTTP
POST to all configured peers. Each peer stores the event in its own `federation_inbound_audit`
table, making it queryable via the `/v1/federation/audit/tail` endpoint.

All federation communication uses bearer tokens. There is no HMAC or certificate pinning
in this MVP — see Known Limitations below.

---

## Quick start (two instances on one server)

### 1. Create the peer-b data directory

```bash
mkdir -p /tmp/sudo-ai-peer-b-data/logs
```

### 2. Set the admin token (same for both peers in this example)

```bash
export SUDO_ADMIN_TOKEN="your-admin-token-here"
```

### 3. Start peer-a (primary)

```bash
pm2 start ops/federation/ecosystem-peer-a.config.cjs
```

Peer-a runs on port 18900. It publishes outbound events to peer-b using the bearer token
`demo_fed_token_a`, and accepts inbound events bearing `demo_fed_token_b`.

### 4. Start peer-b (secondary)

```bash
pm2 start ops/federation/ecosystem-peer-b.config.cjs
```

Peer-b runs on port 18901 with a separate data directory (`/tmp/sudo-ai-peer-b-data`)
to avoid DB collision with peer-a.

### 5. Run the smoke test

```bash
export SUDO_ADMIN_TOKEN="your-admin-token-here"
bash ops/federation/federation-smoke.sh
```

Expected output:

```
Step 1: peer-a liveness ...
  PASS: peer-a /v1/admin/metrics returned 200
Step 2: peer-b liveness ...
  PASS: peer-b /v1/admin/metrics returned 200
...
  PASSED: 6
  FAILED: 0
```

---

## Production deployment (two VPSes)

### VPS-A configuration

Set these environment variables before running pm2, or place them in `config/.env`:

```bash
SUDO_INSTANCE_ID=vps-a
SUDO_ADMIN_TOKEN=<your-admin-token>

# Token VPS-A presents when publishing to VPS-B
# Must match VPS-B's SUDO_FEDERATION_INBOUND_TOKENS entry
SUDO_FEDERATION_PEERS='[{"name":"vps-b","url":"https://vps-b.example.com:18900","token":"<TOKEN_A_TO_B>"}]'

# Token(s) VPS-A accepts from VPS-B
SUDO_FEDERATION_INBOUND_TOKENS='["<TOKEN_B_TO_A>"]'
```

### VPS-B configuration

```bash
SUDO_INSTANCE_ID=vps-b
SUDO_ADMIN_TOKEN=<your-admin-token>

SUDO_FEDERATION_PEERS='[{"name":"vps-a","url":"https://vps-a.example.com:18900","token":"<TOKEN_B_TO_A>"}]'

SUDO_FEDERATION_INBOUND_TOKENS='["<TOKEN_A_TO_B>"]'
```

### Token generation

Generate cryptographically random tokens for production:

```bash
openssl rand -hex 32
```

Each directed link (A→B and B→A) needs its own token. Never reuse tokens across directions
or deployments.

### nginx reverse proxy (recommended)

Place the gateway behind nginx with TLS termination. The federation endpoints are:

```
POST  /v1/federation/audit/ingest   — inbound from trusted peer (federation bearer)
GET   /v1/federation/audit/tail     — peer reads our audit tail (federation bearer)
GET   /v1/federation/peers          — list configured peers (admin bearer)
GET   /v1/federation/stats          — federation telemetry (admin bearer)
```

Example nginx location block (add inside your existing server block):

```nginx
# Federation endpoints — pass through to SUDO-AI gateway
location /v1/federation/ {
    proxy_pass         http://127.0.0.1:18900;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_read_timeout 10s;
}
```

---

## Verifying a live federation link

Check peer-b stats from VPS-A:

```bash
curl -s -H "Authorization: Bearer $SUDO_ADMIN_TOKEN" \
  http://localhost:18900/v1/federation/stats | jq .
```

Expected response after at least one published event:

```json
{
  "ok": true,
  "data": {
    "outboundSeq": 1,
    "inboundEventCount": 0,
    "peersConfigured": 1,
    "lastInboundTs": null,
    "lastOutboundTs": 1712345678000
  }
}
```

Query peer-b's inbound audit tail from peer-b's host:

```bash
curl -s \
  -H "Authorization: Bearer demo_fed_token_a" \
  "http://localhost:18901/v1/federation/audit/tail?since=0&limit=50" | jq .
```

---

## Resetting smoke test data

To wipe peer-b's ephemeral data and start fresh:

```bash
pm2 stop sudo-ai-peer-b
bash ops/federation/federation-smoke.sh --fresh
mkdir -p /tmp/sudo-ai-peer-b-data/logs
pm2 start ops/federation/ecosystem-peer-b.config.cjs
```

The `--fresh` flag removes `/tmp/sudo-ai-peer-b-data` only. The primary instance's
data directory is never touched.

---

## Known limitations (Wave 7E MVP scope)

These are intentional constraints, not bugs. Future waves will address them.

1. **No HMAC / signature verification** — Federation events are authenticated only
   by the bearer token. A compromised token allows event injection. Add HMAC-SHA256
   body signing in a future wave.

2. **No conflict resolution on duplicate seq** — The ingest endpoint is idempotent
   (returns 409 on duplicate `(instanceId, seq)`) but does not merge or resolve
   conflicting payloads. If two instances emit the same seq from the same instanceId,
   the first write wins.

3. **No multi-hop routing** — Events are published to directly configured peers only.
   If A knows B and B knows C, A's events do NOT automatically reach C.

4. **No P2P discovery** — Peers must be statically configured via env vars. There is
   no dynamic membership protocol.

5. **No back-pressure / retry** — `publishEvent` is fire-and-forget. If a peer is
   temporarily offline, those events are lost. Add a durable outbound queue in a
   future wave.

6. **Demo tokens in ecosystem configs** — The ecosystem files use `demo_fed_token_a`
   and `demo_fed_token_b`. Replace with `openssl rand -hex 32` generated values before
   any non-local deployment.
