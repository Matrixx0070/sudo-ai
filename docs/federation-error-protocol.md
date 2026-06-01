# Federation Error Protocol — SUDO-AI v4

**Wave 2 — Federation Error Protocol** enables distributed error reporting and collaborative fix propagation across federation peers.

## Overview

The Federation Error Protocol allows SUDO-AI instances to:
1. Report errors encountered during operation to a central admin instance
2. Receive notifications when fixes for known errors are deployed
3. Contribute tokens to a shared pool for compute resource sharing
4. Query error reports and token pool status

This creates a self-healing network where one instance's learned fixes propagate to all peers.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FEDERATION ERROR PROTOCOL FLOW                           │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
  │   Peer Bot   │      │   Admin Bot  │      │   GitHub     │
  │  (instance)  │      │  (coordinator)│      │   Issues     │
  └──────┬───────┘      └──────┬───────┘      └──────┬───────┘
         │                     │                      │
         │  POST /error-report │                      │
         │────────────────────>│                      │
         │  {errorSignature,   │                      │
         │   context, severity}│                      │
         │                     │                      │
         │                     │  Create Issue        │
         │                     │─────────────────────>│
         │                     │                      │
         │                     │  Fix PR Merged       │
         │                     │<─────────────────────│
         │                     │                      │
         │  POST /fix-notify   │                      │
         │<────────────────────│                      │
         │  {errorSignature,   │                      │
         │   fixDescription,   │                      │
         │   patchVersion}     │                      │
         │                     │                      │
         │  Apply Fix          │                      │
         │  (auto/manual)      │                      │
         │                     │                      │
         │  POST /token-       │                      │
         │  contribute         │                      │
         │────────────────────>│                      │
         │  {tokenAmount,      │                      │
         │   capability}       │                      │
         │                     │                      │

```

### Data Flow

1. **Error Detection**: Peer bot encounters an error during operation
2. **Error Reporting**: Peer sends `POST /v1/federation/error-report` to admin
3. **Issue Creation**: Admin creates/links GitHub issue for tracking
4. **Fix Development**: Fix is developed and merged via PR
5. **Fix Notification**: Admin broadcasts `POST /v1/federation/fix-notify` to all peers
6. **Fix Application**: Peers apply the fix automatically or flag for manual review
7. **Token Contribution**: Peers can contribute compute tokens to shared pool

## Endpoints

### POST /v1/federation/error-report

Submit an error report from a peer instance to the admin coordinator.

**Method:** `POST`
**Path:** `/v1/federation/error-report`
**Auth:** Federation bearer token (`SUDO_FEDERATION_INBOUND_TOKENS`)

**Request Body:**

```json
{
  "errorSignature": "sha256:abc123...",
  "errorType": "tool_execution_failure",
  "errorMessage": "bwrap: permission denied",
  "severity": "HIGH",
  "context": {
    "toolName": "tool.synthesize",
    "phase": "spawn",
    "environment": {
      "NODE_ENV": "production",
      "SUDO_SECCOMP_DISABLE": "0"
    }
  },
  "stackTrace": "Error: ...\n  at ...",
  "occurredAt": "2026-05-31T14:30:00.000Z",
  "instanceId": "peer-a-uuid"
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `errorSignature` | string | yes | SHA-256 hash of normalized error for deduplication |
| `errorType` | string | yes | Categorization: `tool_execution_failure`, `permission_denied`, `timeout`, `memory_overflow`, `network_error`, `parse_error`, `other` |
| `errorMessage` | string | yes | Human-readable error message (truncated to 1024 chars) |
| `severity` | string | yes | One of: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` |
| `context` | object | no | Additional context about the error |
| `stackTrace` | string | no | Stack trace (truncated to 4096 chars) |
| `occurredAt` | string | yes | ISO 8601 timestamp |
| `instanceId` | string | yes | Unique identifier of the reporting instance |

**Response (200):**

```json
{
  "ok": true,
  "data": {
    "reportId": "rpt_abc123",
    "errorSignature": "sha256:abc123...",
    "status": "acknowledged",
    "githubIssueId": 42,
    "createdAt": "2026-05-31T14:30:01.000Z"
  }
}
```

**Response (409 — Duplicate):**

```json
{
  "ok": false,
  "error": "duplicate_signature",
  "existingReportId": "rpt_xyz789",
  "githubIssueId": 42
}
```

**Error Codes:**

| Status | Code | Meaning |
|---|---|---|
| `200` | — | Report accepted |
| `400` | `invalid_body` | Missing required fields or malformed JSON |
| `401` | `unauthorized` | Invalid or missing federation bearer token |
| `409` | `duplicate_signature` | Error already reported |
| `429` | `rate_limited` | Too many reports from this instance |
| `500` | `internal_error` | Server error |

---

### POST /v1/federation/fix-notify

Admin broadcasts fix notification to all peer instances.

**Method:** `POST`
**Path:** `/v1/federation/fix-notify`
**Auth:** Admin bearer token (`GATEWAY_TOKEN`)

**Request Body:**

```json
{
  "errorSignature": "sha256:abc123...",
  "fixDescription": "Added LD_PRELOAD seal to prevent execve syscall",
  "fixType": "code_patch",
  "patchVersion": "2.2h",
  "commitHash": "bdc6581",
  "affectedComponents": ["tool.synthesize", "sandbox-manager"],
  "applyMethod": "auto_restart",
  "instructions": "Restart pm2 process to apply fix",
  "verifiedBy": ["security-r1", "quality-engineer"],
  "notifiedAt": "2026-05-31T16:00:00.000Z"
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `errorSignature` | string | yes | SHA-256 hash of the error this fix resolves |
| `fixDescription` | string | yes | Human-readable description of the fix |
| `fixType` | string | yes | One of: `code_patch`, `config_change`, `env_var`, `manual_intervention` |
| `patchVersion` | string | yes | Version/tag containing the fix |
| `commitHash` | string | no | Git commit hash |
| `affectedComponents` | array | no | List of components affected |
| `applyMethod` | string | no | One of: `auto_restart`, `manual_apply`, `config_reload` |
| `instructions` | string | no | Step-by-step instructions |
| `verifiedBy` | array | no | Verification steps passed |
| `notifiedAt` | string | yes | ISO 8601 timestamp |

**Response (200):**

```json
{
  "ok": true,
  "data": {
    "notificationId": "ntf_def456",
    "peersNotified": 3,
    "peersAcknowledged": 2,
    "sentAt": "2026-05-31T16:00:01.000Z"
  }
}
```

**Error Codes:**

| Status | Code | Meaning |
|---|---|---|
| `200` | — | Notification sent |
| `400` | `invalid_body` | Missing required fields |
| `401` | `unauthorized` | Invalid or missing admin bearer token |
| `500` | `internal_error` | Server error |

---

### POST /v1/federation/token-contribute

Peer contributes compute tokens to the shared federation pool.

**Method:** `POST`
**Path:** `/v1/federation/token-contribute`
**Auth:** Federation bearer token (`SUDO_FEDERATION_INBOUND_TOKENS`)

**Request Body:**

```json
{
  "tokenAmount": 1000,
  "tokenType": "compute_minutes",
  "capability": "tool.synthesize",
  "expiresAt": "2026-06-01T00:00:00.000Z",
  "constraints": {
    "maxConcurrent": 2,
    "allowedSeverities": ["LOW", "MEDIUM"]
  },
  "contributedAt": "2026-05-31T12:00:00.000Z"
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `tokenAmount` | number | yes | Amount of tokens contributed |
| `tokenType` | string | yes | One of: `compute_minutes`, `api_calls`, `storage_mb`, `bandwidth_mb` |
| `capability` | string | no | Specific capability this token enables |
| `expiresAt` | string | no | ISO 8601 expiration timestamp |
| `constraints` | object | no | Usage constraints |
| `contributedAt` | string | yes | ISO 8601 timestamp |

**Response (200):**

```json
{
  "ok": true,
  "data": {
    "contributionId": "cnt_ghi789",
    "tokenAmount": 1000,
    "poolTotal": 15000,
    "creditedAt": "2026-05-31T12:00:01.000Z"
  }
}
```

**Error Codes:**

| Status | Code | Meaning |
|---|---|---|
| `200` | — | Contribution accepted |
| `400` | `invalid_body` | Missing required fields or invalid values |
| `401` | `unauthorized` | Invalid or missing federation bearer token |
| `429` | `rate_limited` | Too many contributions |
| `500` | `internal_error` | Server error |

---

### GET /v1/federation/error-reports

Retrieve error reports (admin only).

**Method:** `GET`
**Path:** `/v1/federation/error-reports`
**Auth:** Admin bearer token (`GATEWAY_TOKEN`)

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `severity` | string | — | Filter by severity: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` |
| `status` | string | — | Filter by status: `acknowledged`, `in_progress`, `fixed`, `dismissed` |
| `since` | number | 1h ago | Epoch ms to fetch reports since |
| `limit` | number | 100 | Max results (1-500) |
| `offset` | number | 0 | Pagination offset |

**Request Example:**

```http
GET /v1/federation/error-reports?severity=HIGH&status=in_progress&limit=50
Authorization: Bearer <admin-token>
```

**Response (200):**

```json
{
  "ok": true,
  "data": {
    "reports": [
      {
        "reportId": "rpt_abc123",
        "errorSignature": "sha256:abc123...",
        "errorType": "tool_execution_failure",
        "severity": "HIGH",
        "status": "in_progress",
        "instanceId": "peer-a-uuid",
        "githubIssueId": 42,
        "createdAt": "2026-05-31T14:30:00.000Z",
        "updatedAt": "2026-05-31T15:00:00.000Z"
      }
    ],
    "total": 15,
    "limit": 50,
    "offset": 0
  }
}
```

**Error Codes:**

| Status | Code | Meaning |
|---|---|---|
| `200` | — | Reports retrieved |
| `401` | `unauthorized` | Invalid or missing admin bearer token |
| `429` | `rate_limited` | Rate limit exceeded |
| `500` | `internal_error` | Server error |

---

### GET /v1/federation/token-pool

Retrieve token pool status (admin only).

**Method:** `GET`
**Path:** `/v1/federation/token-pool`
**Auth:** Admin bearer token (`GATEWAY_TOKEN`)

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `tokenType` | string | — | Filter by token type |
| `capability` | string | — | Filter by capability |

**Request Example:**

```http
GET /v1/federation/token-pool?tokenType=compute_minutes
Authorization: Bearer <admin-token>
```

**Response (200):**

```json
{
  "ok": true,
  "data": {
    "totalTokens": 15000,
    "availableTokens": 12500,
    "allocatedTokens": 2500,
    "byType": {
      "compute_minutes": 10000,
      "api_calls": 3000,
      "storage_mb": 2000
    },
    "byCapability": {
      "tool.synthesize": 5000,
      "browser.search": 3000,
      "general": 7000
    },
    "contributors": [
      {
        "instanceId": "peer-a-uuid",
        "contributed": 5000,
        "remaining": 4500
      }
    ],
    "lastUpdated": "2026-05-31T16:00:00.000Z"
  }
}
```

**Error Codes:**

| Status | Code | Meaning |
|---|---|---|
| `200` | — | Pool status retrieved |
| `401` | `unauthorized` | Invalid or missing admin bearer token |
| `500` | `internal_error` | Server error |

---

## Kill-Switches

| Environment Variable | Default | Effect when `=1` |
|---|---|---|
| `SUDO_FED_ERROR_REPORT_DISABLE=1` | unset | Peers cannot submit error reports |
| `SUDO_FED_FIX_NOTIFY_DISABLE=1` | unset | Admin cannot broadcast fix notifications |
| `SUDO_FED_TOKEN_POOL_DISABLE=1` | unset | Token contribution and pool queries disabled |
| `SUDO_FEDERATION_PEERS` | unset | CSV of peer URLs — if unset, federation disabled |
| `SUDO_FEDERATION_INBOUND_TOKENS` | unset | JSON array of inbound tokens — if unset, inbound requests rejected |

**Semantics:** All kill-switches use exact `=== '1'` matching. Any other value (including unset) leaves the feature enabled.

---

## Security

### Payload Sanitization

All request bodies are sanitized before processing:

- **String fields**: Truncated to max length, control characters stripped
- **Error messages**: Limited to 1024 characters
- **Stack traces**: Limited to 4096 characters, file paths redacted
- **Environment variables**: Filtered to exclude secrets (keys matching `*_KEY`, `*_TOKEN`, `*_SECRET`)

### Token Encryption

Federation bearer tokens should be:

- Generated using `crypto.randomBytes(32).toString('hex')`
- Stored in environment variables, never in source code
- Rotated every 90 days minimum
- Transmitted only over HTTPS in production

### Rate Limits

| Endpoint | Limit | Window |
|---|---|---|
| `POST /error-report` | 10 requests | per instance, per 60 seconds |
| `POST /fix-notify` | 5 requests | per admin, per 60 seconds |
| `POST /token-contribute` | 20 requests | per instance, per 60 seconds |
| `GET /error-reports` | 30 requests | per admin, per 60 seconds |
| `GET /token-pool` | 60 requests | per admin, per 60 seconds |

Rate limit responses return `429` with `Retry-After` header.

### Authentication

- **Federation endpoints** (`/error-report`, `/token-contribute`): Validate against `SUDO_FEDERATION_INBOUND_TOKENS` using timing-safe comparison
- **Admin endpoints** (`/fix-notify`, `/error-reports`, `/token-pool`): Validate against `GATEWAY_TOKEN`

---

## Configuration

### Peer Instance Setup

```bash
# config/.env for peer instances

# Federation peer configuration
SUDO_FEDERATION_PEERS='[{"name":"admin","url":"https://admin.sudoai.local:18900","token":"fed_sk_abc123..."}]'

# Inbound tokens (what this peer accepts from others)
SUDO_FEDERATION_INBOUND_TOKENS='["fed_sk_xyz789..."]'

# Kill-switches (optional)
SUDO_FED_ERROR_REPORT_DISABLE=0
SUDO_FED_TOKEN_CONTRIBUTE_ENABLE=1
```

### Admin Instance Setup

```bash
# config/.env for admin instance

# Federation configuration (admin doesn't need peer list for error-report)
SUDO_FEDERATION_INBOUND_TOKENS='["fed_sk_abc123...", "fed_sk_xyz789..."]'

# Admin token (for fix-notify and admin queries)
GATEWAY_TOKEN=admin_sk_secret123...

# GitHub integration (for issue creation)
GITHUB_TOKEN=ghp_...
GITHUB_REPO=owner/repo
```

### Token Generation

```bash
# Generate a federation token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Output: fed_sk_a1b2c3d4e5f6...
```

---

## Example curl Commands

### Submit Error Report (Peer → Admin)

```bash
curl -X POST https://admin.sudoai.local:18900/v1/federation/error-report \
  -H "Authorization: Bearer fed_sk_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "errorSignature": "sha256:abc123...",
    "errorType": "tool_execution_failure",
    "errorMessage": "bwrap: permission denied",
    "severity": "HIGH",
    "context": {
      "toolName": "tool.synthesize",
      "phase": "spawn"
    },
    "occurredAt": "2026-05-31T14:30:00.000Z",
    "instanceId": "peer-a-uuid"
  }'
```

### Broadcast Fix Notification (Admin → Peers)

```bash
curl -X POST https://admin.sudoai.local:18900/v1/federation/fix-notify \
  -H "Authorization: Bearer admin_sk_secret..." \
  -H "Content-Type: application/json" \
  -d '{
    "errorSignature": "sha256:abc123...",
    "fixDescription": "Added LD_PRELOAD seal to prevent execve syscall",
    "fixType": "code_patch",
    "patchVersion": "2.2h",
    "commitHash": "bdc6581",
    "applyMethod": "auto_restart",
    "instructions": "Restart pm2 process to apply fix",
    "notifiedAt": "2026-05-31T16:00:00.000Z"
  }'
```

### Contribute Tokens (Peer → Admin)

```bash
curl -X POST https://admin.sudoai.local:18900/v1/federation/token-contribute \
  -H "Authorization: Bearer fed_sk_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "tokenAmount": 1000,
    "tokenType": "compute_minutes",
    "capability": "tool.synthesize",
    "expiresAt": "2026-06-01T00:00:00.000Z",
    "contributedAt": "2026-05-31T12:00:00.000Z"
  }'
```

### Query Error Reports (Admin)

```bash
curl -X GET "https://admin.sudoai.local:18900/v1/federation/error-reports?severity=HIGH&limit=50" \
  -H "Authorization: Bearer admin_sk_secret..."
```

### Query Token Pool (Admin)

```bash
curl -X GET "https://admin.sudoai.local:18900/v1/federation/token-pool" \
  -H "Authorization: Bearer admin_sk_secret..."
```

---

## Troubleshooting

### 401 Unauthorized

- Verify the bearer token matches `SUDO_FEDERATION_INBOUND_TOKENS` (for peer endpoints) or `GATEWAY_TOKEN` (for admin endpoints)
- Tokens are compared using timing-safe equality — exact match required
- Check for whitespace in token values

### 409 Duplicate Signature

- The error has already been reported
- Check the returned `existingReportId` and `githubIssueId`
- No action needed — the error is already being tracked

### 429 Rate Limited

- Wait for the duration specified in `Retry-After` header
- Reduce polling/reporting frequency
- Consider batching error reports

### 503 Service Unavailable

- Federation may be disabled via kill-switch
- Check `SUDO_FEDERATION_PEERS` is set
- Verify peer instance is healthy at `/health` endpoint

---

## Related Documentation

- See [`api-reference.md`](./api-reference.md) for general API conventions
- See [`alignment-architecture.md`](./alignment-architecture.md) for federation architecture overview
- See `~/.claude/team-memory/wave7e-closed.md` for Wave 7E federation MVP details
