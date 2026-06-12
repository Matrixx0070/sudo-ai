# API Reference — SUDO-AI v4

SUDO-AI exposes an OpenAI-compatible HTTP API on port `18900` (default; port 3000 was used by earlier versions). Any OpenAI client library works with this API by pointing it at `http://localhost:18900` and using your configured token.

---

## Authentication

All endpoints require a Bearer token in the `Authorization` header.

```
Authorization: Bearer <SUDO_AI_API_TOKEN>
```

Set `SUDO_AI_API_TOKEN` in `config/.env`. If the env var is not set, the API server starts but **all requests return 401**. There is no anonymous access.

**Configure the port:**
```bash
# config/.env
GATEWAY_PORT=18900
SUDO_AI_API_TOKEN=your-secret-token-here
```

---

## Endpoints

### POST /v1/chat/completions

Send a chat completion request. The agent receives the messages, runs its tool-calling loop, and returns the final response.

**Request:**

```http
POST /v1/chat/completions
Authorization: Bearer your-secret-token
Content-Type: application/json
```

```json
{
  "model": "xai/grok-4-1-fast-non-reasoning",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "What is the current disk usage on this machine?"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 2048,
  "stream": false
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | yes | Provider-qualified model ID. Must match one of the configured models. |
| `messages` | array | yes | Conversation history. Standard OpenAI message format: `role` (system/user/assistant) + `content` (string). |
| `temperature` | float | no | Overrides the model's configured temperature for this request. Range: 0–2. |
| `max_tokens` | integer | no | Maximum tokens to generate. Overrides `maxOutputTokens` from config. |
| `stream` | boolean | no | Currently not supported. Pass `false` or omit. |

**Response:**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1711459200,
  "model": "xai/grok-4-1-fast-non-reasoning",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Current disk usage:\n- /: 142GB used of 500GB (28%)\n- /data: 23GB used of 100GB (23%)"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 156,
    "completion_tokens": 48,
    "total_tokens": 204
  }
}
```

**Error responses:**

| Status | Meaning |
|---|---|
| `400` | Invalid request body (missing required fields, malformed JSON) |
| `401` | Missing or invalid Bearer token |
| `500` | Agent or LLM error during processing |

---

### GET /v1/models

List all models configured and available in the current instance.

**Request:**

```http
GET /v1/models
Authorization: Bearer your-secret-token
```

**Response:**

```json
{
  "object": "list",
  "data": [
    {
      "id": "xai/grok-4-1-fast-non-reasoning",
      "object": "model",
      "created": 1711459200,
      "owned_by": "sudo-ai"
    },
    {
      "id": "xai/grok-4-fast-reasoning",
      "object": "model",
      "created": 1711459200,
      "owned_by": "sudo-ai"
    },
    {
      "id": "openai/gpt-4o",
      "object": "model",
      "created": 1711459200,
      "owned_by": "sudo-ai"
    }
  ]
}
```

The model list reflects the primary models and fallback model from `config/sudo-ai.json5`, deduplicated.

---

### POST /v1/skills/import

Import a skill from a URI source into the skill registry. The importer fetches the manifest and body from the given URI, deduplicates by name and content hash, then persists the skill.

**Request:**

```http
POST /v1/skills/import
Authorization: Bearer your-secret-token
Content-Type: application/json
```

```json
{
  "source": "https://skills.example.com/my-skill/manifest.json",
  "trustOverride": "indexed"
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | string | yes | URI of the skill manifest to import. Accepted schemes: `https://`, `file://`, `skill://`. Use `source` in preference to the legacy alias `uri`. |
| `uri` | string | no | Legacy alias for `source`. If both are present, `source` takes precedence. |
| `trustOverride` | string | no | Override the trust tier assigned to the imported skill. Accepted values: `bundled`, `indexed`, `unreviewed`, `workspace`. If omitted, the importer assigns a tier based on the URI scheme and manifest. |

**Response (200):**

```json
{
  "skill": {
    "name": "my-skill",
    "version": "1.0.0",
    "contentHash": "abc123...",
    "trustTier": "indexed"
  },
  "imported": true
}
```

The `skill` field contains the manifest returned by the importer. Exact fields depend on the manifest schema.

**Error responses:**

| Status | Meaning |
|---|---|
| `400` | Missing or invalid `source`/`uri`, unsupported URI scheme, or invalid JSON body |
| `401` | Missing or invalid Bearer token |
| `404` | Source URI resolved but skill was not found at that location |
| `409` | Skill already imported — same name and content hash already exist in the registry |
| `422` | Capability check failed — skill requires capabilities not available in this instance |
| `429` | Rate limited. `Retry-After` header indicates seconds to wait. Limit: 10 requests per 60 seconds per Bearer token (or per client IP if no token). |
| `500` | Import succeeded but persistence to the registry failed |
| `502` | Upstream source returned a server error or was unreachable |
| `504` | Import timed out |

---

### GET /.well-known/agentskills.json

Returns an [agentskills.io](https://agentskills.io)-compatible discovery manifest. External crawlers and tooling use this endpoint to locate the skill registry for this instance.

**Public endpoint. No authentication required. CORS wildcard (`Access-Control-Allow-Origin: *`) is set on all responses.**

**Request:**

```http
GET /.well-known/agentskills.json
```

**Response (200):**

```json
{
  "registry": "http://localhost:18900/v1/registry/skills",
  "spec_version": "1.0",
  "provider": "sudo-ai",
  "total_skills": 5,
  "last_updated_iso": "2026-04-19T19:24:33.832Z"
}
```

**Response headers (200):**

| Header | Value |
|---|---|
| `ETag` | SHA-256 of the response body (hex string) |
| `Cache-Control` | `public, max-age=60` |
| `Access-Control-Allow-Origin` | `*` |

The `registry` URL is sourced from the `SUDO_PUBLIC_BASE_URL` environment variable, defaulting to `http://localhost:18900`. It is never derived from request headers.

**Conditional requests:**

Send `If-None-Match: <etag>` to avoid re-downloading an unchanged manifest. When the ETag matches the current value the server returns `304 Not Modified` with an empty body and the same caching headers.

**Error responses:**

| Status | Meaning |
|---|---|
| `304` | `If-None-Match` matched the current ETag. Empty body. |
| `404` | Any other `/.well-known/*` path (e.g. `/.well-known/agentskills.xml`). Body: `{"error":{"message":"Not found","code":404}}` |

**Metrics** (visible at `GET /v1/admin/metrics`):

| Metric | Incremented on |
|---|---|
| `sudo_wellknown_manifest_requests_total` | Every 200 response |
| `sudo_wellknown_manifest_not_modified_total` | Every 304 response |
| `sudo_wellknown_manifest_not_found_total` | Every 404 response |

**Example:**

```bash
curl http://localhost:18900/.well-known/agentskills.json
```

---

### GET /v1/registry/skills

List all publicly available skills exposed by this instance. Crawlers auto-discover this endpoint via `/.well-known/agentskills.json`.

**Public endpoint. No authentication required.**

**Request:**

```http
GET /v1/registry/skills
```

**Response (200):**

```json
{
  "skills": [
    {
      "id": "browser-search",
      "name": "browser.search",
      "version": "1.0.0",
      "description": "Search the web and return structured results.",
      "trust_tier": "bundled"
    }
  ],
  "total": 5
}
```

See `GET /v1/registry/skills/:id` for the full manifest of an individual skill and `GET /v1/registry/skills/:id/raw` for the raw SKILL.md source.

---

### GET /v1/admin/compare

Run two models against the same prompt concurrently and return a side-by-side comparison of their outputs, latencies, estimated costs, and complexity scores. Intended for operator evaluation of model routing decisions.

**Request:**

```http
GET /v1/admin/compare?a=<modelId>&b=<modelId>&prompt=<text>
Authorization: Bearer your-secret-token
```

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `a` | string | yes | Model ID for the first model (e.g. `xai/grok-4-1-fast-non-reasoning`). Must be a model the Brain can route to via `runWithModel`. |
| `b` | string | yes | Model ID for the second model. |
| `prompt` | string | yes | The prompt text to send to both models. Maximum 4096 characters. |

**Response (200):**

```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "modelA": "xai/grok-4-1-fast-non-reasoning",
  "modelB": "openai/sonnet",
  "prompt": "Explain gradient descent in one paragraph.",
  "responseA": "Gradient descent is an optimisation algorithm...",
  "responseB": "Gradient descent works by iteratively adjusting...",
  "latencyAms": 812,
  "latencyBms": 1043,
  "costAusd": 0.000124,
  "costBusd": 0.000098,
  "complexityA": { "score": 0.12, "tier": "simple", "signals": ["prompt_length"], "suggested_max_tokens": 2048, "thinking_model": false },
  "complexityB": { "score": 0.12, "tier": "simple", "signals": ["prompt_length"], "suggested_max_tokens": 2048, "thinking_model": false },
  "energyA": { "wh": 0.00041 },
  "energyB": { "wh": 0.00038 },
  "timestamp": "2026-04-17T10:00:00.000Z"
}
```

**Response fields:**

| Field | Type | Description |
|---|---|---|
| `runId` | string (UUID) | Unique identifier for this comparison run |
| `modelA` / `modelB` | string | Model IDs as supplied in query params |
| `prompt` | string | The prompt text as supplied |
| `responseA` / `responseB` | string | Full text output from each model |
| `latencyAms` / `latencyBms` | integer | Wall-clock latency in milliseconds for each model call |
| `costAusd` / `costBusd` | float | Estimated cost in USD based on token counts and configured pricing |
| `complexityA` / `complexityB` | object | Complexity scoring result for the prompt (scored against each model) |
| `energyA` / `energyB` | object | Estimated energy consumption |
| `timestamp` | string (ISO 8601) | UTC timestamp of the comparison |

If `Brain.runWithModel` is not available for a given model, `responseA` or `responseB` will contain a stub message and latency/token counts will be zero.

**Error responses:**

| Status | Meaning |
|---|---|
| `400` | Missing or invalid query parameters, or `prompt` exceeds 4096 characters |
| `401` | Missing or invalid Bearer token |
| `429` | Rate limited. `Retry-After` header indicates seconds to wait. Limit: 5 requests per 60 seconds per Bearer token (or per client IP if no token). Rate limit is checked before authentication. |
| `500` | Unhandled internal error during model calls |

---

### GET /v1/admin/public-key

Return the instance's Ed25519 public key. Federation peers use this to verify `signedArtifact` bodies returned by the `/approve` endpoints.

**Auth:** Bearer token (`SUDO_GATEWAY_TOKEN`). Returns `401` if missing or invalid.

**Request:**

```http
GET /v1/admin/public-key
Authorization: Bearer your-gateway-token
```

**Response (200):**

```json
{
  "ok": true,
  "data": {
    "keyId": "302a3005",
    "algorithm": "ed25519",
    "publicKey": "<DER hex>",
    "generatedAt": "2026-04-19T22:10:03.369Z"
  }
}
```

`keyId` is the first 8 hex characters of the DER-encoded key; it matches the `keyId` field in every `signedArtifact` this instance produces.

---

### Artifact Signing — approve endpoints

When artifact signing is enabled (the default), two endpoints include a `signedArtifact` object in their response. Setting `SUDO_SIGNING_DISABLE=1` omits the field, restoring the unsigned response shape.

**POST /v1/admin/learning/proposals/:id/approve**

Signing on (default): `{ "proposal": {...}, "signedArtifact": { "payload": {...}, "signedAt": "...", "keyId": "...", "signature": "...", "artifactType": "config_proposal" } }`

Signing off: `{ "proposal": {...} }`

**POST /v1/admin/skills/optimizations/:id/approve**

Signing on (default): `{ "ok": true, "data": {...}, "signedArtifact": { "payload": {...}, "signedAt": "...", "keyId": "...", "signature": "...", "artifactType": "skill" } }`

Signing off: `{ "ok": true, "data": {...} }`

Use `GET /v1/admin/public-key` to retrieve the key needed to verify the `signature` field.

---

## Kill-switches

All kill-switches use exact-`"1"`-match semantics: the feature is disabled only when the variable is set to the string `"1"`. Any other value, including unset, leaves the feature enabled.

**Computer-use and cross-platform control — see also `docs/cross-platform-control-guide.md`, `docs/configuration.md`, and `README.md` for control semantics and safety controls.**

| Variable | Feature disabled |
|---|---|
| `SUDO_COMPUTER_USE_DISABLE=1` | IComputerUse unified cross-platform control (exec/browser/file/gui/desktop) + legacy computer.use. Linux is fully supported; Windows/macOS backends are experimental |
| `SUDO_CROSS_PLATFORM_DISABLE=1` | Windows/macOS backends; force Linux-only control paths |
| `SUDO_TOOL_LEARNING_DISABLE=1` | ToolOutcomeLearner; disables learning on *all* tool outcomes incl. control actions |
| `SUDO_SANDBOX_DISABLE=1` | bwrap/seccomp/LD_PRELOAD sandbox for exec/control (leave enabled unless you fully control and trust the host) |
| `SUDO_MCP_DISABLE=1` | MCP server integration (SSE/WS/OAuth) |
| `SUDO_MCP_OAUTH_DISABLE=1` | MCP OAuth PKCE |
| `SUDO_MCP_REMOTE_DISABLE=1` | MCP remote tool access |
| `SUDO_DASHBOARD_DISABLE=1` | Web dashboard (stats/health/alignment/metrics) |
| `SUDO_BRAIN_RACE_DISABLE=1` | Brain parallel model race |
| `SUDO_BRAIN_CONSENSUS_DISABLE=1` | 3-model Jaccard consensus |
| `SUDO_AUTO_APPROVE=1` | (enabler) Skips manual approval prompts in autonomy tiers. Off by default; enable only when you intend the agent to act without per-action confirmation |
| `SUDO_TAINT_DISABLE=1` | Taint tracking wiring |
| `SUDO_SIGNING_DISABLE=1` | Artifact signing on `/approve` endpoints |
| `SUDO_SKILL_INDEX_DISABLE=1` | Skill-to-tool reverse index |
| `SUDO_FED_*_DISABLE=1` | Federation features (see federation-error-protocol.md) |

**Note on computer-use control:** Control actions (IComputerUse) are full-power and run with the privileges you grant the process. The agent is owner-controlled — it acts on the operator's instructions within the limits of those privileges. Safety is layered: kill-switches (above), autonomy/approval tiers, the bwrap/seccomp sandbox, SecurityGuard, self-repair on failed control actions, and learning from outcomes. Audit logging records control activity. Linux is fully supported; the Windows and macOS backends are experimental. See the cross-platform control guide for usage and platform notes.

### Key directory override: SUDO_SIGNER_KEY_DIR

**Purpose:** Override the default `data/keys/` directory where ArtifactSigner reads and writes the ed25519 keypair (`wave10-signer.priv`, `wave10-signer.pub`). If unset, `data/keys/` relative to the project root is used.

**Trust boundary:** This variable is operator-set only. It must come from `ecosystem.config.cjs` or a systemd unit file. Never accept its value from user input, HTTP request headers, query parameters, or request bodies.

**Attack vector:** An attacker who can set this variable can (a) redirect private key writes to an attacker-readable path, exfiltrating the signing key, or (b) point the reader at an attacker-supplied public key, breaking signature verification for federation peers.

**Mitigation:** File permissions are enforced on write — `0600` for the private key, `0644` for the public key, `0700` for the directory. These permissions apply regardless of the path value, but they do not protect against a path that points into an attacker-writable subtree. Treat any change to this variable with the same scrutiny as a credential rotation.

**Contrast with binary kill-switches:** Kill-switches such as `SUDO_SIGNING_DISABLE` use exact `=== '1'` matching — they are binary toggles with no free-form input surface. `SUDO_SIGNER_KEY_DIR` accepts an arbitrary filesystem path, making operator discipline more critical.

**Related:** `SUDO_KEY_ROTATION_DB_PATH` (path override for the key-rotation SQLite database) carries the same trust class. Both path-override variables should be audited together when reviewing deployment configuration.

---

## Opt-in intelligence flags

The inverse of kill-switches: these enable learning/prediction features that are **OFF by default**. Boolean flags use the same exact-`"1"`-match semantics as kill-switches (any other value, including unset, leaves the feature off). Numeric flags accept a clean base-10 integer in the noted domain; malformed or out-of-range values are ignored (the feature stays at its unbounded/off default). All are fail-open: a failed init logs a warning and never blocks boot or a request.

| Variable | Type | Default | Effect when enabled |
|---|---|---|---|
| `SUDO_PREDICTOR_LOOP=1` | boolean | off | Anticipatory Predictor injection: a `# HEADS UP` block with relevant predictions is added to the first turn of a session |
| `SUDO_PREDICTOR_AUTO_RESOLVE=1` | boolean | off | Expiry sweep: pending predictions past their `expiresAt` are resolved as `incorrect` before `anticipate()` / `detectAnomalies()`, feeding `getAccuracy()` and the accuracy anomaly check |
| `SUDO_FAILURE_LEARNER_DB=1` | boolean | off | FailureLearner uses a durable SQLite store in `data/mind.db` (default: in-memory, process-lifetime). Falls back to in-memory if the DB cannot be opened |
| `SUDO_TOOL_OUTCOME_LEARNER=1` | boolean | off | Attaches ToolOutcomeLearner to the agent loop: failed tool calls are recorded in the FailureLearner and known prevention-rule hints are injected before tool execution. Honors `SUDO_TOOL_LEARNING_DISABLE=1` |
| `SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN` | non-negative integer | unbounded | Caps GoalPlanner semantic-planning calls per run; `0` is valid and means template-only planning (no semantic calls). Suggested starting value: `3` |
| `SUDO_SKILL_FORGE_ASYNC=1` | boolean | off | SkillForge scan runs cooperatively, yielding to the event loop between batches; output is identical to the synchronous scan |
| `SUDO_POLICY_AGG_WINDOW_DAYS` | positive integer | all history | Bounds trace-policy aggregate refresh to the most recent N days (suggested starting value: `30`) |
| `SUDO_STUCK_DETECTOR=1` | boolean | off | Result-aware stuck detection in the agent loop: consecutive identical tool *errors* from the same tool inject a change-strategy warning at `SUDO_STUCK_DETECTOR_WARN_THRESHOLD` (positive integer, default `3`) and terminate the run at `SUDO_STUCK_DETECTOR_ABORT_THRESHOLD` (positive integer, default `5`). Complements LoopGuard/DoomLoop (which key on tool+args before execution); wait/poll-style tools are exempt |
| `SUDO_PROMPT_CACHE=1` | boolean | off | Stable-prefix discipline for provider prompt caches: the volatile Current Date & Time block moves below the system prompt's dynamic boundary, and tool definitions (both the system-prompt tools list and the serialized tool schemas) are sorted by name so the request prefix is byte-identical across calls. Layout-only — no content is added or removed. On Anthropic models it additionally places explicit `cache_control: ephemeral` breakpoints on the last tool definition and on the stable system-prompt prefix (everything above the dynamic boundary); requests to other providers are unchanged. `SUDO_PROMPT_CACHE_BREAKPOINTS_DISABLE=1` keeps the stable prefix but skips the explicit breakpoints |

**Related (documented elsewhere):** the trace-learning flywheel flags `SUDO_TRACE_LEARNING=1`, `SUDO_TRACE_POLICY=1`, and `SUDO_POLICY_REFRESH_MS` follow the same opt-in pattern.

---

## curl Examples

### Simple chat request

```bash
curl -X POST http://localhost:18900/v1/chat/completions \
  -H "Authorization: Bearer $SUDO_AI_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "xai/grok-4-1-fast-non-reasoning",
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

### Request with tool use (agent runs autonomously)

The agent decides which tools to use. You do not specify tools in the request — the agent's full tool set is always available.

```bash
curl -X POST http://localhost:18900/v1/chat/completions \
  -H "Authorization: Bearer $SUDO_AI_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "xai/grok-4-1-fast-non-reasoning",
    "messages": [
      {"role": "user", "content": "Search the web for the latest Node.js release and tell me the version number."}
    ]
  }'
```

The agent will call `browser.search`, retrieve the result, and return a text answer. The response contains only the final text — intermediate tool calls are not exposed in the API response.

**Computer-use control example (cross-platform IComputerUse):**
Use a prompt that triggers computer control (e.g. "Take a desktop screenshot via GUI, list files in the working directory using exec, write a short note, and navigate the browser to example.com"). The agent will use IComputerUse (or legacy computer.use on Linux), and outcomes feed ToolOutcomeLearner automatically. Linux is fully supported; Windows and macOS backends are experimental. Disable via `SUDO_COMPUTER_USE_DISABLE=1`. Full details: `docs/cross-platform-control-guide.md`. Self-repair and the autonomy/approval tiers apply to control actions as described in the cross-platform control guide.

### Multi-turn conversation

```bash
curl -X POST http://localhost:18900/v1/chat/completions \
  -H "Authorization: Bearer $SUDO_AI_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "xai/grok-4-1-fast-non-reasoning",
    "messages": [
      {"role": "user", "content": "Read the file /root/sudo-ai-v3/package.json"},
      {"role": "assistant", "content": "The package.json shows sudo-ai version 3.0.0 with dependencies including Electron 34.5.8, React 19.2.4..."},
      {"role": "user", "content": "What version of TypeScript is it using?"}
    ]
  }'
```

### List available models

```bash
curl http://localhost:18900/v1/models \
  -H "Authorization: Bearer $SUDO_AI_API_TOKEN"
```

---

## Using with OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:18900/v1",
    api_key="your-sudo-ai-api-token",
)

response = client.chat.completions.create(
    model="xai/grok-4-1-fast-non-reasoning",
    messages=[
        {"role": "user", "content": "What processes are currently running on this machine?"}
    ],
)

print(response.choices[0].message.content)
```

---

## Using with OpenAI Node.js SDK

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:18900/v1',
  apiKey: process.env.SUDO_AI_API_TOKEN,
});

const response = await client.chat.completions.create({
  model: 'xai/grok-4-1-fast-non-reasoning',
  messages: [
    { role: 'user', content: 'List all TypeScript files in /root/sudo-ai-v3/src/core/' },
  ],
});

console.log(response.choices[0].message.content);
```

---

## Differences from OpenAI API

| Feature | OpenAI API | SUDO-AI API |
|---|---|---|
| Streaming | Supported | Not supported (pass `stream: false`) |
| Tool/function calling in request | Supported | Not applicable — agent uses its own tool set |
| Images in messages | Supported (vision models) | Not supported |
| Fine-tuned models | Supported | Not supported |
| Audio | Supported | Not supported |
| Embeddings endpoint | Supported | Not included |
| Model list | OpenAI models | Your configured models |
| Token counting | Exact | Estimated |

The API is designed for programmatic access to the agent's reasoning and tool-execution capabilities, not as a full OpenAI replacement.

---

## Rate Limiting

The SecurityGuard applies rate limiting per user ID. Via the API, the user ID is derived from the Bearer token. Repeated rapid requests may be throttled.

Rate limit responses (429) include a `Retry-After` header containing the number of seconds to wait before the next request. Compare endpoint enforces 5 requests per 60 seconds per Bearer token.

---

## Enabling the API Server

The API server starts automatically in CLI mode if `GATEWAY_PORT` is set in `.env`. To explicitly control it:

```bash
# config/.env

# Set both to enable the API server
GATEWAY_PORT=18900
SUDO_AI_API_TOKEN=choose-a-long-random-secret

# To disable the API server entirely: leave GATEWAY_PORT unset
```

The API server binds to `0.0.0.0` by default. To restrict to localhost only, set a firewall rule or reverse proxy accordingly. Do not expose the API server to the public internet without a reverse proxy with TLS.

---

## Federation Error Protocol

The Federation Error Protocol provides distributed error reporting and fix propagation across federation peers.

**Full documentation:** See [`federation-error-protocol.md`](./federation-error-protocol.md)

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/federation/error-report` | Federation bearer | Peer submits error report to admin |
| `POST` | `/v1/federation/fix-notify` | Admin bearer | Admin broadcasts fix notification to peers |
| `POST` | `/v1/federation/token-contribute` | Federation bearer | Peer contributes compute tokens to pool |
| `GET` | `/v1/federation/error-reports` | Admin bearer | Query error reports (admin only) |
| `GET` | `/v1/federation/token-pool` | Admin bearer | Query token pool status (admin only) |

### Authentication

- **Federation endpoints** (`/error-report`, `/token-contribute`): Validate against `SUDO_FEDERATION_INBOUND_TOKENS`
- **Admin endpoints** (`/fix-notify`, `/error-reports`, `/token-pool`): Validate against `GATEWAY_TOKEN`

### Kill-Switches

| Variable | Effect when `=1` |
|---|---|
| `SUDO_FED_ERROR_REPORT_DISABLE=1` | Peers cannot submit error reports |
| `SUDO_FED_FIX_NOTIFY_DISABLE=1` | Admin cannot broadcast fix notifications |
| `SUDO_FED_TOKEN_POOL_DISABLE=1` | Token contribution and pool queries disabled |

### Example: Submit Error Report

```bash
curl -X POST http://localhost:18900/v1/federation/error-report \
  -H "Authorization: Bearer $SUDO_FEDERATION_INBOUND_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "errorSignature": "sha256:abc123...",
    "errorType": "tool_execution_failure",
    "errorMessage": "bwrap: permission denied",
    "severity": "HIGH",
    "occurredAt": "2026-05-31T14:30:00.000Z",
    "instanceId": "peer-a-uuid"
  }'
```

### Example: Query Token Pool

```bash
curl http://localhost:18900/v1/federation/token-pool \
  -H "Authorization: Bearer $GATEWAY_TOKEN"
```
