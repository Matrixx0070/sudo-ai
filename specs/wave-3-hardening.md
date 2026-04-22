# Wave 3 Production-Hardening Spec

**Version:** 1.0  
**Date:** 2026-04-12  
**Status:** Ready for builders

---

## 1. Overview

Wave 3 closes three critical production gaps: (1) a Secrets Vault encrypts every
credential at rest with AES-256-GCM so API keys, bot tokens, and OAuth secrets
never live in plain `.env` files again; (2) per-peer rate limiting guards every
channel inbound handler so no single Telegram user, Discord channel, or WhatsApp
JID can flood the agent; (3) an MCP Loopback server exposes all SUDO-AI tools,
skills, and workflows over the Model Context Protocol so OpenClaw, Claude Code,
and any other MCP client can call them natively. All three modules are independent
of each other and may build in full parallel. Two pre-wave patches (hooks/index.ts
and tools/types.ts) must be applied by the Lead before builder clocks start.

---

## 2. File Boundaries

### Pre-Wave Lead Patches (Lead applies before any builder starts)

- `/root/sudo-ai-v4/src/core/hooks/index.ts` — add new HookEvent literals and HookContext fields (exact diff in section 6)
- `/root/sudo-ai-v4/src/core/tools/types.ts` — add `safety` field to `ToolDefinition` interface (exact diff in section 6)

### security-builder (owns exclusively)

```
/root/sudo-ai-v4/src/core/security/vault.ts          (new)
/root/sudo-ai-v4/src/core/security/vault-cli.ts      (new — CLI migration shim)
/root/sudo-ai-v4/workspace/vault/                     (runtime data dir, not source)
```

Must NOT touch: `domain-validator.ts`, `approval/allowlist.ts`.

### channels-builder (owns exclusively)

```
/root/sudo-ai-v4/src/core/channels/rate-limit.ts     (new)
```

Plus exactly three one-line edits in existing adapters (listed in section 5 with exact line anchors).
Must NOT touch any other part of the adapter files.

### gateway-builder (owns exclusively)

```
/root/sudo-ai-v4/src/core/gateway/mcp-server.ts      (new)
```

Must NOT touch: `server.ts`, `mcp-adapter.ts` (the existing outbound MCP CLIENT — do not confuse).

### doc-writer (owns exclusively)

```
/root/sudo-ai-v4/docs/vault.md
/root/sudo-ai-v4/docs/rate-limiting.md
/root/sudo-ai-v4/docs/mcp-loopback.md
```

---

## 3. Interfaces

### 3.1 Vault (`src/core/security/vault.ts`)

```typescript
export interface VaultSetOptions {
  /** ISO-8601 expiry; vault.get returns null after this date */
  expiresAt?: string;
}

export interface VaultEntry {
  ciphertext: string;   // hex-encoded
  nonce: string;        // hex-encoded, 12 bytes
  tag: string;          // hex-encoded, 16 bytes
  createdAt: string;    // ISO-8601
  rotatedAt?: string;   // ISO-8601, set on vault.rotate()
  expiresAt?: string;   // ISO-8601, optional
}

export interface VaultNamespace {
  [key: string]: VaultEntry;
}

export interface VaultGetResult {
  value: string;
  entry: Omit<VaultEntry, 'ciphertext' | 'nonce' | 'tag'>;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  remaining: number;
}

// Primary API — module-level singleton exported as `vault`
export interface VaultAPI {
  set(namespace: string, key: string, value: string, opts?: VaultSetOptions): Promise<void>;
  get(namespace: string, key: string, requester: string): Promise<VaultGetResult | null>;
  list(namespace: string): Promise<string[]>;
  rotate(namespace: string, key: string, requester: string): Promise<void>;
  delete(namespace: string, key: string, requester: string): Promise<void>;
}

export declare const vault: VaultAPI;
```

**Internal helpers (not exported):**

```typescript
function deriveMasterKey(): Buffer;
  // Reads SUDO_VAULT_MASTER_KEY (32-byte hex) or derives from
  // SUDO_VAULT_PASSPHRASE via scrypt(pass, salt='sudo-ai-vault-v1', N=16384, r=8, p=1, 32)
  // Throws VaultError('no master key configured') if neither env is set.

function encrypt(plaintext: string, masterKey: Buffer): VaultEntry;
  // randomBytes(12) → nonce
  // createCipheriv('aes-256-gcm', masterKey, nonce) → ciphertext + authTag
  // Returns VaultEntry with hex-encoded values + createdAt = new Date().toISOString()

function decrypt(entry: VaultEntry, masterKey: Buffer): string;
  // Reconstructs Decipher, calls decipher.setAuthTag(), returns plaintext
  // Throws VaultError('decryption failed') on tag mismatch

async function readNamespace(namespace: string): Promise<VaultNamespace>;
  // Reads workspace/vault/<namespace>.json; returns {} if not found
  // Validates namespace matches /^[a-z0-9_-]{1,64}$/

async function writeNamespace(namespace: string, data: VaultNamespace): Promise<void>;
  // Atomic: write to workspace/vault/<namespace>.tmp.json, then rename
  // Uses fs/promises: writeFile + rename

function appendAuditLog(entry: AuditLogEntry): void;
  // Sync append to workspace/vault/audit.log (NDJSON lines)

interface AuditLogEntry {
  ts: string;          // ISO-8601
  action: 'get' | 'set' | 'rotate' | 'delete' | 'list';
  namespace: string;
  key: string;
  requester: string;
  success: boolean;
  reason?: string;     // present on failures
}
```

**Errors:**

```typescript
export class VaultError extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}
// codes: 'no_master_key' | 'invalid_namespace' | 'key_not_found' | 'decryption_failed' | 'key_expired'
```

### 3.2 Rate Limiter (`src/core/channels/rate-limit.ts`)

```typescript
export interface RateLimitConfig {
  /** Tokens refilled per minute (default: SUDO_RATE_LIMIT_PER_MIN env or 20) */
  perMinute: number;
  /** Burst allowance above refill rate (default: SUDO_RATE_LIMIT_BURST env or 5) */
  burst: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  /** Only present when \!allowed */
  retryAfterMs?: number;
  /** Tokens remaining after this check (0 when denied) */
  remaining: number;
}

export interface RateLimiter {
  check(channel: string, peerId: string): Promise<RateLimitCheckResult>;
  reset(channel: string, peerId: string): void;
}

export declare const rateLimiter: RateLimiter;
```

**Internal bucket shape (in-memory only):**

```typescript
interface TokenBucket {
  tokens: number;        // current float token count
  lastRefill: number;    // Date.now() ms
  lastAccess: number;    // Date.now() ms, for GC
  burstWarned: boolean;  // true after the first burst-exceeded reply was sent
}
```

**Config resolution (evaluated once at module load):**

```typescript
function resolveConfig(channel: string): RateLimitConfig {
  // 1. Check SUDO_RATE_LIMIT_<CHANNEL>_PER_MIN and SUDO_RATE_LIMIT_<CHANNEL>_BURST
  //    (channel uppercased, e.g. SUDO_RATE_LIMIT_TELEGRAM_PER_MIN)
  // 2. Fall back to SUDO_RATE_LIMIT_PER_MIN and SUDO_RATE_LIMIT_BURST
  // 3. Default: perMinute=20, burst=5
}
```

**GC:** `setInterval` every 60 000 ms prunes buckets where
`Date.now() - lastAccess > 3_600_000`. Maximum map size guard: if `buckets.size > 50_000`,
evict the 10 000 oldest by `lastAccess`.

**Persistence (opt-in):** When `SUDO_RATE_LIMIT_PERSIST=1`, every 60 s flush
`Map<string, TokenBucket>` to `workspace/rate-limits.json`. On startup, load and
restore if file exists and `lastRefill > Date.now() - 3_600_000`. Key format:
`"${channel}::${peerId}"`.

### 3.3 MCP Server (`src/core/gateway/mcp-server.ts`)

**Distinction:** `mcp-adapter.ts` is the existing OUTBOUND client that calls external
MCP servers. `mcp-server.ts` is the new INBOUND server that exposes SUDO-AI as an
MCP server. They are completely separate.

```typescript
export interface MCPServerOptions {
  /** Transport: 'stdio' (default) or 'http'. 'http' is Phase 2 — stub only in Wave 3. */
  transport: 'stdio' | 'http';
  /** HTTP port — only used when transport='http'. Default: 18801 */
  port?: number;
  /** Bearer token required in Authorization header. From SUDO_MCP_TOKEN env. */
  token: string;
  /** Comma-separated tool name allowlist. Empty string = all non-destructive tools. */
  exposedTools?: string;
  /** Injected ToolRegistry instance */
  registry: ToolRegistry;
}

export interface MCPLoopbackServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;
}

export function createMCPServer(opts: MCPServerOptions): MCPLoopbackServer;
```

**Protocol surface (JSON-RPC 2.0 over stdio):**

```typescript
// Methods handled:
// initialize        → respond with serverInfo + capabilities
// tools/list        → enumerate exposed ToolDefinitions
// tools/call        → execute via registry.execute(), stream result
// prompts/list      → enumerate skills (stub, returns [])  // Phase 2
// resources/list    → enumerate workflows (stub, returns []) // Phase 2

// Auth for stdio: read Authorization header equivalent from initialize params.clientInfo.token
// Auth for http: standard Bearer token in Authorization header on each request

interface InitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: {
    name: string;
    version: string;
    token?: string;   // SUDO-AI extension for stdio auth
  };
}

interface MCPToolListEntry {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}
```

**Tool safety classification:**

```typescript
// Uses the ToolDefinition.safety field added by Lead pre-wave patch.
// safety: 'readonly' | 'destructive' — default 'readonly' if absent.
// Exposed = (exposedTools allowlist matches) OR (safety === 'readonly' AND exposedTools is empty)
```

**Hook emission:**

```typescript
// On every tools/call:
hooks.emit('mcp:tool-call', {
  event: 'mcp:tool-call',
  toolName: name,
  args,
  sessionId: mcpClientId,   // derived from clientInfo.name
  meta: { mcpTransport: opts.transport, mcpClientName: clientInfo.name }
});
```

**Error policy:** Never include stack traces in JSON-RPC error responses.
Error messages use the format `"Tool execution failed"` for internal errors;
`"Tool not found"` for unknown names; `"Unauthorized"` for auth failures.
Internal error detail goes to the pino logger only.

---

## 4. Data Models

### 4.1 Vault on-disk format

File: `workspace/vault/<namespace>.json`
Namespace regex: `/^[a-z0-9_-]{1,64}$/`

```json
{
  "GROK_API_KEY": {
    "ciphertext": "a3f2...",
    "nonce": "0102030405060708090a0b0c",
    "tag": "deadbeef...",
    "createdAt": "2026-04-12T00:00:00.000Z",
    "rotatedAt": "2026-04-12T01:00:00.000Z"
  }
}
```

Audit log: `workspace/vault/audit.log` — NDJSON, one JSON object per line.

### 4.2 Rate limit persistence format

File: `workspace/rate-limits.json`

```json
{
  "telegram::123456789": {
    "tokens": 18.3,
    "lastRefill": 1744502400000,
    "lastAccess": 1744502400000,
    "burstWarned": false
  }
}
```

### 4.3 Environment Variables

| Variable | Module | Default | Description |
|---|---|---|---|
| `SUDO_VAULT_MASTER_KEY` | vault | — | 32-byte hex master key |
| `SUDO_VAULT_PASSPHRASE` | vault | — | Passphrase → scrypt derive |
| `SUDO_RATE_LIMIT_PER_MIN` | rate-limit | `20` | Global per-peer token refill rate |
| `SUDO_RATE_LIMIT_BURST` | rate-limit | `5` | Global burst allowance |
| `SUDO_RATE_LIMIT_<CHAN>_PER_MIN` | rate-limit | — | Per-channel override (chan uppercased) |
| `SUDO_RATE_LIMIT_<CHAN>_BURST` | rate-limit | — | Per-channel burst override |
| `SUDO_RATE_LIMIT_PERSIST` | rate-limit | `0` | Set `1` to persist across restarts |
| `SUDO_MCP_TOKEN` | mcp-server | — | Bearer token for MCP auth |
| `SUDO_MCP_EXPOSE_TOOLS` | mcp-server | `` (all readonly) | Comma-separated allowlist |
| `SUDO_MCP_PORT` | mcp-server | `18801` | HTTP transport port (Phase 2) |
| `SUDO_MCP_TRANSPORT` | mcp-server | `stdio` | `stdio` or `http` |

### 4.4 Pre-Wave Patches

**Patch A — `src/core/hooks/index.ts`**

Insert into `HookEvent` union after line 83 (`| 'after_install';`), before the closing of the type:

```typescript
  // Wave 3 — Vault events
  | 'vault:set'
  | 'vault:get'
  | 'vault:rotate'
  | 'vault:delete'
  // Wave 3 — Rate limit events
  | 'rate-limit:triggered'
  // Wave 3 — MCP loopback events
  | 'mcp:tool-call';
```

Insert into `HookContext` interface after line 118 (`meta?: Record<string, unknown>;`), before the closing brace:

```typescript
  /** Vault namespace (vault:* events). */
  vaultNamespace?: string;
  /** Vault key name (vault:* events). */
  vaultKey?: string;
  /** Requester ID — agentId or sessionId (vault:* events). */
  requester?: string;
  /** Peer identifier for rate-limit:triggered events. Reuses peerId pattern. */
  peerId?: string;
```

**Patch B — `src/core/tools/types.ts`**

Insert into `ToolDefinition` interface after line 99 (`requiresConfirmation?: boolean;`):

```typescript
  /**
   * Safety classification for MCP loopback exposure.
   * 'readonly' tools may be exposed without an explicit allowlist.
   * 'destructive' tools require explicit listing in SUDO_MCP_EXPOSE_TOOLS.
   * Defaults to 'readonly' when absent.
   */
  safety?: 'readonly' | 'destructive';
```

---

## 5. Wave Dependency Graph

```
[Lead applies Patch A + Patch B] ─────────────────────────────────────────────
         │                                                                      │
         ├──► security-builder: vault.ts + vault-cli.ts        (fully parallel)
         │
         ├──► channels-builder: rate-limit.ts + 3 adapter edits (fully parallel)
         │
         └──► gateway-builder: mcp-server.ts                   (fully parallel)
                      │
                      └── depends on ToolRegistry type import only (already exists)
                          depends on HookManager import (already exists)
                          depends on Patch B safety field (Lead applies first)
```

All three builders may start simultaneously after Lead patches land.
No builder depends on the output of another builder.

### Exact Adapter Integration Points for channels-builder

The channels-builder adds ONLY these three edits to existing files.
No other lines in those files are touched.

**`src/core/channels/telegram.ts` — `_handleInbound` method**

Insert after line 767 (end of `if (\!this._isAllowed(userId))` block), before
the `if (\!this._handler)` check at line 770:

```typescript
    // Wave 3: per-peer rate limiting
    const rl = await rateLimiter.check('telegram', userId);
    if (\!rl.allowed) {
      if (\!rl.retryAfterMs || rl.remaining === 0) {
        const secs = Math.ceil((rl.retryAfterMs ?? 60000) / 1000);
        try { await ctx.reply(`Please slow down — try again in ${secs}s`); } catch { /* ignore */ }
      }
      return;
    }
```

Also add to top of file: `import { rateLimiter } from './rate-limit.js';`

**`src/core/channels/discord.ts` — `_handleMessage` method**

Insert after line 247 (end of `if (\!this._isAllowedChannel(...))` block), before
`const cleanText` at line 250:

```typescript
    // Wave 3: per-peer rate limiting
    const rl = await rateLimiter.check('discord', msg.channelId);
    if (\!rl.allowed) {
      if (rl.remaining === 0) {
        const secs = Math.ceil((rl.retryAfterMs ?? 60000) / 1000);
        try { await (msg.channel as { send(s: string): Promise<unknown> }).send(
          `Please slow down — try again in ${secs}s`
        ); } catch { /* ignore */ }
      }
      return;
    }
```

Also add to top of file: `import { rateLimiter } from './rate-limit.js';`

**`src/core/channels/whatsapp.ts` — `_processInbound` method**

Insert after line 246 (end of `if (this.allowedJids.size > 0 && ...)` block), before
`const text =` at line 248:

```typescript
    // Wave 3: per-peer rate limiting
    const rl = await rateLimiter.check('whatsapp', sender || from);
    if (\!rl.allowed) {
      if (rl.remaining === 0) {
        const secs = Math.ceil((rl.retryAfterMs ?? 60000) / 1000);
        const jid = (sender || from).includes('@') ? sender || from : `${sender || from}@s.whatsapp.net`;
        try { await this.socket?.sendMessage(jid, {
          text: `Please slow down — try again in ${secs}s`
        }); } catch { /* ignore */ }
      }
      return;
    }
```

Also add to top of file: `import { rateLimiter } from './rate-limit.js';`

### Rate-limit reply deduplication rule

`burstWarned` on the bucket: flip to `true` on first denied message; only send
the "please slow down" reply when transitioning from `burstWarned=false` to `true`.
Reset `burstWarned` to `false` when the bucket refills above 1 token. This prevents
a "please slow down" flood during a burst.

---

## 6. Adversarial Review Checklist

The Security Engineer runs this checklist in round 1:

### Vault

- [ ] Master key exfiltration: no pino log line contains `masterKey`, `ciphertext`, `nonce`, `tag`, or `value` at any level. Grep all vault functions.
- [ ] Weak KDF: scrypt params must be N=16384, r=8, p=1, keylen=32. `SUDO_VAULT_MASTER_KEY` must validate exactly 64 hex chars and throw, not silently truncate.
- [ ] Nonce reuse: each `encrypt()` must call `randomBytes(12)`. No static or counter nonce. Unit test must assert two encryptions of identical plaintext yield different nonce+ciphertext.
- [ ] Atomic write: `writeNamespace` must use `writeFile(tmp) + rename(tmp, final)`. Tmp filename must include `randomUUID()` to avoid collision.
- [ ] Namespace injection: validate against `/^[a-z0-9_-]{1,64}$/` before any path join. No `..` traversal possible.
- [ ] Audit log path: hardcoded, never derived from user-controlled namespace/key values.
- [ ] Vault CLI: `vault import-env` must prompt for confirmation and show which keys
  would be imported before importing. No silent mass-import.

### Rate Limiter

- [ ] Memory blowup: 50 000-bucket hard cap + 10 000-eviction must exist. GC interval must not accumulate on repeated `rateLimiter` imports.
- [ ] Clock skew: negative `Date.now()` deltas clamped to 0 — no free token grants from backward clock steps.
- [ ] peerId injection: reject or strip `::` from peerId before constructing the `"${channel}::${peerId}"` map key to prevent collision bypass.
- [ ] Persistence deserialization: validate each `rate-limits.json` entry on load; skip and log malformed entries.

### MCP Server

- [ ] Auth bypass: token must be re-validated on every `tools/call`, not only during `initialize`. No bypassable per-session cache.
- [ ] Tool injection: `registry.execute()` receives only the params object. No user-controlled field spreads into `ToolContext`.
- [ ] Error disclosure: `catch` in `tools/call` must never forward raw `Error.message` or stack. Pattern: `log.error(err); respond({ error: { code: -32603, message: 'Tool execution failed' } })`.
- [ ] Destructive tool bypass: when `SUDO_MCP_EXPOSE_TOOLS` is empty, `safety === 'destructive'` tools must be absent from `tools/list` and rejected at `tools/call`.
- [ ] `SUDO_MCP_TOKEN` absent: `createMCPServer` must throw at startup, never run unauthenticated.

---

## 7. Test Matrix

Quality Engineer minimum test counts (Vitest, all must pass):

### Vault (`src/core/security/vault.test.ts`) — min 18 tests

| Group | Tests |
|---|---|
| deriveMasterKey | valid 64-hex key accepted; invalid length throws; passphrase derives deterministically; neither env set throws |
| encrypt/decrypt round-trip | encrypt then decrypt recovers plaintext; two encrypts produce different nonces; tag mutation throws |
| vault.set + vault.get | happy path; expired entry returns null; unknown key returns null; requester logged in audit |
| vault.list | returns key names only, not values |
| vault.rotate | old ciphertext replaced; rotatedAt updated; previous value unrecoverable from rotated entry |
| vault.delete | key removed from namespace file; audit logged |
| namespace validation | rejects `../etc`, rejects empty, rejects >64 chars, rejects uppercase |
| atomic write | concurrent writes do not corrupt (mock rename) |
| audit log | audit.log entries are valid NDJSON; all 5 actions produce entries |

### Rate Limiter (`src/core/channels/rate-limit.test.ts`) — min 14 tests

| Group | Tests |
|---|---|
| check — allowed | fresh peer gets `allowed=true`; remaining = burst+perMinute-1 |
| check — burst exhaustion | burst+1 requests → last is `\!allowed`; retryAfterMs > 0 |
| check — refill | advance clock by 60s; tokens refilled; `allowed=true` again |
| burstWarned deduplication | 10 rapid denials → only first produces warning response (burstWarned flag) |
| reset | reset clears bucket; next check is allowed |
| per-channel config | SUDO_RATE_LIMIT_TELEGRAM_PER_MIN overrides global |
| GC | buckets older than 1h are pruned; map stays under 50 000 |
| clock skew | negative delta clamped to 0 tokens granted |
| peerId with `::` | treated safely; no false collision |
| persistence round-trip | flush → reload → bucket state restored (mock fs) |

### MCP Server (`src/core/gateway/mcp-server.test.ts`) — min 16 tests

| Group | Tests |
|---|---|
| createMCPServer | throws when SUDO_MCP_TOKEN absent; resolves when valid |
| initialize handshake | valid token accepted; invalid token returns error -32600 |
| tools/list | returns only readonly tools when SUDO_MCP_EXPOSE_TOOLS empty |
| tools/list — allowlist | explicit list returns exactly named tools, including destructive |
| tools/call — happy path | calls registry.execute(); returns content string |
| tools/call — not found | returns JSON-RPC error -32601 |
| tools/call — unauthorized | wrong token returns -32600 |
| tools/call — blocked destructive | tool not in allowlist returns -32601 |
| tools/call — internal error | registry throws; response error message is generic (no stack) |
| hook emission | mcp:tool-call hook fires with correct toolName and args |
| stdio framing | newline-delimited JSON frames correctly; partial lines buffered |
| stop() | cleans up listeners; isRunning becomes false |

---

## 8. Open Questions

1. **Rate limit persistence:** Default is ephemeral (`SUDO_RATE_LIMIT_PERSIST=0`). Confirm ephemeral-only is acceptable, or flip default to `1`.

2. **Unclassified tool safety:** Tools missing `safety` field are treated as `'readonly'` for MCP exposure. Confirm this is correct, or mandate `'destructive'` as the safer default.

3. **Vault CLI — remove from .env:** After `vault import-env` copies keys into vault, should the `.env` entries be deleted? Safer long-term but destructive. Confirm.

4. **MCP HTTP transport:** Stubbed with `throw new Error('HTTP transport not yet implemented')`. Confirm whether a stub test is required.

5. **HTTP gateway rate limiting:** `server.ts` has no per-caller rate limit. Wire Wave 3 rate limiter into it now, or defer to Wave 4?
