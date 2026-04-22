# Wave 4b: SQLite Session Store + Channel Adapters (Email & SMS)

**Date:** 2026-04-12  
**Author:** Architect  
**Status:** APPROVED FOR IMPLEMENTATION

---

## 1. Overview

Wave 4b delivers two workstreams:

**A. SQLite Session Store** — displace the JSONL-based `JournalSessionStore` with a
purpose-built `SqliteSessionStore` layered on top of the existing `MindDB` / `better-sqlite3`
stack. The existing `sessions` and `messages` tables in `schema.ts` (v3) gain five new
columns via ALTER TABLE migration. A new `SqliteSessionStore` class exposes the
Hermes-compatible API (`createSession`, `appendMessage`, `searchSessions`, etc.) and
replaces `JournalSessionStore` in `DualSessionManager`. A one-shot JSONL importer
(`migrate-jsonl.ts`) reads existing `.jsonl` files and imports them into SQLite.

**B. Email + SMS Channel Adapters** — two new adapters completing the Hermes 21-platform
parity goal. Slack (`slack.ts`), Signal (`signal.ts`), and Matrix (`matrix.ts`) already
exist and are in full operation; they are NOT touched by this wave.
- `EmailAdapter`: IMAP inbound (imapflow) + SMTP outbound (nodemailer — already in deps).
- `SmsAdapter`: Twilio inbound webhook + REST outbound.

`ChannelType` union in `src/core/channels/types.ts` gains `'email' | 'sms'`.

---

## 2. File Boundaries

### memory-builder (owns exclusively)
```
src/core/memory/sqlite-session-store.ts      # New file — primary deliverable
src/core/memory/sqlite-migrations/001-init.sql  # New file — schema DDL
src/core/memory/migrate-jsonl.ts             # New file — one-shot import
src/core/memory/schema.ts                    # ALTER TABLE additions ONLY
src/core/memory/db.ts                        # Read-only; must not modify
```

### channels-builder (owns exclusively)
```
src/core/channels/types.ts                   # Append 'email' | 'sms' to ChannelType
src/core/channels/email.ts                   # New file
src/core/channels/sms.ts                     # New file
src/core/channels/index.ts                   # Append two exports
src/cli.ts                                   # Add adapter registrations (email + sms)
```

### doc-writer (owns exclusively)
```
README.md                                    # Channel table + env var reference
docs/channels.md                             # New or updated channel guide
docs/memory.md                               # SQLite store docs
```

Zero overlap — no file appears in more than one boundary.

---

## 3. Interfaces + TypeScript Types

### 3.1 SqliteSessionStore (`src/core/memory/sqlite-session-store.ts`)

```typescript
import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Row shapes (mirrors new schema columns)
// ---------------------------------------------------------------------------

export interface SessionRow {
  session_id:       string;       // UUIDv4, PK
  source_platform:  string;       // ChannelType value
  user_id:          string;       // peerId from UnifiedMessage
  model:            string;
  system_prompt:    string | null;
  parent_session_id: string | null; // compression chain
  input_tokens:     number;
  output_tokens:    number;
  cost_usd:         number;
  title:            string | null;
  created_at:       string;       // ISO-8601
  updated_at:       string;
}

export interface MessageRow {
  id:          number;            // AUTOINCREMENT PK
  session_id:  string;
  role:        'user' | 'assistant' | 'system' | 'tool';
  content:     string;
  created_at:  string;
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface ListSessionsOptions {
  limit?:    number;   // default 50
  afterId?:  string;   // cursor-based pagination (session_id)
  userId?:   string;   // filter by user_id
  platform?: string;   // filter by source_platform
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class SqliteSessionStore {
  constructor(db: Database);                            // accepts raw better-sqlite3 instance (from MindDB.db)

  createSession(params: Omit<SessionRow, 'created_at' | 'updated_at'>): void;
  appendMessage(sessionId: string, role: MessageRow['role'], content: string): number;
  getSession(sessionId: string): SessionRow | undefined;
  getMessages(sessionId: string, limit?: number): MessageRow[];
  listSessions(opts?: ListSessionsOptions): SessionRow[];
  searchSessions(query: string): SessionRow[];           // FTS5 BM25; searches messages.content
  linkParent(sessionId: string, parentId: string): void;
  deleteSession(sessionId: string): boolean;             // cascades to messages via FK
}
```

Design note: `SqliteSessionStore` wraps the raw `better-sqlite3` `Database` instance
obtained from `MindDB.db`. It does NOT subclass or replace `MindDB`. All prepared
statements are initialised once in the constructor and reused. `searchSessions` uses the
new `session_messages_fts` virtual table (see §4).

### 3.2 EmailAdapter (`src/core/channels/email.ts`)

```typescript
import type { ChannelAdapter } from './adapter.js';
import type { ChannelType, MessageHandler, SendOptions } from './types.js';

export class EmailAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'email';
  readonly isConnected: boolean;
  constructor();                                    // reads env vars listed in §5
  start(): Promise<void>;
  stop(): Promise<void>;
  send(peerId: string, text: string, options?: SendOptions): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
```

Env vars: `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT` (default 993), `EMAIL_IMAP_USER`,
`EMAIL_IMAP_PASS_VAULT_KEY` (Vault key, NOT raw password), `EMAIL_SMTP_HOST`,
`EMAIL_SMTP_PORT` (default 587), `EMAIL_SMTP_FROM`.

Receive path: `imapflow` IDLE connection on INBOX; `mail-parser` decodes MIME.  
`peerId` = normalized `From` address.  
`chatType` = always `'dm'`.  
Send path: `nodemailer` createTransport SMTP.

### 3.3 SmsAdapter (`src/core/channels/sms.ts`)

```typescript
import type { ChannelAdapter } from './adapter.js';
import type { ChannelType, MessageHandler, SendOptions } from './types.js';

export class SmsAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'sms';
  readonly isConnected: boolean;
  constructor();                                    // reads env vars listed in §5
  start(): Promise<void>;
  stop(): Promise<void>;
  send(peerId: string, text: string, options?: SendOptions): Promise<void>;  // peerId = E.164 phone
  onMessage(handler: MessageHandler): void;
}
```

Env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
`TWILIO_WEBHOOK_PORT` (default 3012), `TWILIO_WEBHOOK_SECRET` (for signature validation).

Receive path: lightweight `http.createServer` on `TWILIO_WEBHOOK_PORT`; validates
`X-Twilio-Signature` using `twilio.validateRequest()` before dispatching.  
`peerId` = `From` E.164 number.  
`chatType` = always `'dm'`.  
Send path: `twilio` REST client `messages.create`.

### 3.4 ChannelType extension (`src/core/channels/types.ts`)

Append to the existing union — no other changes to this file:

```typescript
export type ChannelType =
  | 'telegram' | 'whatsapp' | 'discord' | 'slack'
  | 'signal'   | 'matrix'   | 'irc'     | 'web'
  | 'email'    | 'sms';                          // NEW in wave-4b
```

---

## 4. Schema DDL + Migrations

### 4.1 New file: `src/core/memory/sqlite-migrations/001-init.sql`

This migration EXTENDS the existing `sessions` and `messages` tables; it does NOT
drop or recreate them. Run via `db.exec()` wrapped in the `IF NOT EXISTS` guard for
the ALTER statements (use `PRAGMA table_info` check or `try/catch` per-column).

```sql
-- ============================================================
-- Wave 4b: sessions table extensions (schema v6)
-- All ALTER TABLE statements must be wrapped in try/catch
-- in the migration runner because SQLite cannot check IF NOT EXISTS
-- for columns.
-- ============================================================

ALTER TABLE sessions ADD COLUMN source_platform  TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN user_id          TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN system_prompt    TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN input_tokens     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN output_tokens    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cost_usd         REAL    NOT NULL DEFAULT 0;

-- Index new filter columns
CREATE INDEX IF NOT EXISTS idx_sessions_source_platform ON sessions(source_platform);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id         ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);

-- ============================================================
-- FTS5 virtual table over messages.content (wave-4b searchSessions)
-- Content-table mirrors messages; rowid = messages.id
-- ============================================================

CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
  content,
  content     = 'messages',
  content_rowid = 'id',
  tokenize    = 'porter unicode61'
);

-- Sync triggers for session_messages_fts

CREATE TRIGGER IF NOT EXISTS smfts_ai
  AFTER INSERT ON messages
  BEGIN
    INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
  END;

CREATE TRIGGER IF NOT EXISTS smfts_ad
  AFTER DELETE ON messages
  BEGIN
    INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
  END;

CREATE TRIGGER IF NOT EXISTS smfts_au
  AFTER UPDATE ON messages
  BEGIN
    INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
    INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
```

### 4.2 Migration runner in `SqliteSessionStore` constructor

```typescript
// Pseudo-code — builder implements exactly this pattern
private _runMigrations(db: Database): void {
  const newColumns = [
    ['sessions', 'source_platform',   "TEXT NOT NULL DEFAULT ''"],
    ['sessions', 'user_id',           "TEXT NOT NULL DEFAULT ''"],
    ['sessions', 'system_prompt',     'TEXT'],
    ['sessions', 'parent_session_id', 'TEXT'],
    ['sessions', 'input_tokens',      'INTEGER NOT NULL DEFAULT 0'],
    ['sessions', 'output_tokens',     'INTEGER NOT NULL DEFAULT 0'],
    ['sessions', 'cost_usd',          'REAL    NOT NULL DEFAULT 0'],
  ] as const;

  for (const [table, col, def] of newColumns) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
    catch { /* column already exists — safe to ignore */ }
  }
  // then exec indexes + FTS virtual table + triggers from 001-init.sql
}
```

### 4.3 JSONL migrator (`src/core/memory/migrate-jsonl.ts`)

One-shot CLI script. Reads `JournalSessionStore` index at `~/.sudo-ai/sessions/sessions.json`,
iterates every JSONL file, reconstructs `SessionRow` from journal events, calls
`SqliteSessionStore.createSession` + `appendMessage`. Safe to run on already-migrated
data (upsert semantics: skip if `session_id` already exists).

Export: `export async function migrateJsonlToSqlite(journalBaseDir: string, db: Database): Promise<{ imported: number; skipped: number }>`

---

## 5. Dependencies to Add to `package.json`

| Package | Purpose | Already present? |
|---------|---------|-----------------|
| `better-sqlite3` | SQLite driver | YES — `^12.8.0` |
| `@types/better-sqlite3` | types | YES — devDep `^7.6.13` |
| `nodemailer` | SMTP outbound | YES — `^8.0.4` |
| `@types/nodemailer` | types | YES — `^7.0.11` |
| `imapflow` | IMAP inbound (replaces node-imap) | NO — add `^1.0.172` |
| `mailparser` | MIME decode | NO — add `^3.7.3` |
| `@types/mailparser` | types | NO — add `^3.4.6` (devDep) |
| `twilio` | SMS REST + signature validation | NO — add `^5.7.0` |

Commands:
```
pnpm add imapflow mailparser twilio
pnpm add -D @types/mailparser
```

Do NOT add `@slack/bolt` — the existing `SlackAdapter` uses raw fetch and must not
be replaced. Do NOT add `matrix-bot-sdk` — `MatrixAdapter` uses raw fetch.

---

## 6. Adversarial Review Checklist

| Risk | File | Mitigation |
|------|------|-----------|
| SQL injection via `searchSessions` query | `sqlite-session-store.ts` | Pass user query as FTS5 parameter: `db.prepare("SELECT ... FROM session_messages_fts WHERE session_messages_fts MATCH ?").all(query)` — never interpolate into SQL string |
| IMAP credentials in env plaintext | `email.ts` | `EMAIL_IMAP_PASS_VAULT_KEY` holds a Vault key; constructor calls `VaultClient.get(key)` at startup. Raw password env var is FORBIDDEN |
| SMTP credentials in env plaintext | `email.ts` | Same Vault pattern via `EMAIL_SMTP_PASS_VAULT_KEY` |
| Twilio webhook spoofing | `sms.ts` | Call `twilio.validateRequest(authToken, sig, url, body)` on every inbound POST; return 403 and drop message if validation fails |
| Signal CLI path injection | `signal.ts` | Already uses `execFile` (not `exec`) — shell metacharacters cannot reach the shell. EXISTING code is safe; builder must NOT change this file |
| JSONL migration path traversal | `migrate-jsonl.ts` | Use `path.resolve` + assert the resolved path starts with `journalBaseDir` before reading each JSONL file |
| FTS5 MATCH query injection | `sqlite-session-store.ts` | FTS5 MATCH does not permit arbitrary SQL; still use parameterized binding; catch and rethrow `ChannelError` on MATCH syntax errors |
| Twilio AccountSid / AuthToken leakage in logs | `sms.ts` | Never log `TWILIO_AUTH_TOKEN`; log only last 4 chars of `TWILIO_ACCOUNT_SID` |

---

## 7. Test Matrix

All tests in `tests/unit/` and `tests/integration/` per project convention.

### memory-builder tests

| Test | File | Type |
|------|------|------|
| `createSession` inserts row + resolves with `getSession` | `tests/unit/sqlite-session-store.test.ts` | unit |
| `appendMessage` increments message count | same | unit |
| `listSessions` paginates via `afterId` | same | unit |
| `listSessions` filters by `userId` and `platform` | same | unit |
| `searchSessions` returns results matching FTS5 query | same | unit |
| `searchSessions` ignores SQL-like metacharacters without throwing | same | unit |
| `linkParent` sets `parent_session_id` FK | same | unit |
| `deleteSession` cascades to `messages` | same | unit |
| Migration runner is idempotent on second run | same | unit |
| JSONL → SQLite round-trip (5 sessions, 20 messages each) | `tests/integration/migrate-jsonl.test.ts` | integration |

### channels-builder tests

| Test | File | Type |
|------|------|------|
| `EmailAdapter` rejects construction without `EMAIL_IMAP_USER` | `tests/unit/email-adapter.test.ts` | unit |
| `EmailAdapter.send` calls nodemailer `sendMail` with correct from/to | same (mock transport) | unit |
| `SmsAdapter` rejects construction without `TWILIO_ACCOUNT_SID` | `tests/unit/sms-adapter.test.ts` | unit |
| `SmsAdapter` webhook handler rejects unsigned requests (403) | same | unit |
| `SmsAdapter.send` calls `twilio.messages.create` with E.164 peerId | same (mock client) | unit |
| `ChannelType` union includes `'email'` and `'sms'` at compile time | `tests/unit/channel-types.test.ts` | type-check |

---

## 8. Wave Execution Plan

```
Wave 4b-parallel:
  memory-builder   ──────────────────────────► integrator
  channels-builder ──────────────────────────► integrator
  doc-writer       ──────────────────────────► (no blocking dep)

  integrator ──► security-engineer ──► quality-engineer ──► done
```

memory-builder and channels-builder run in parallel with zero file overlap.
doc-writer runs in parallel; blocks on no one.
Integrator runs after BOTH builders signal completion.

---

## 9. Open Questions

1. **VaultClient interface**: `email.ts` must call `VaultClient.get(key)` for IMAP/SMTP
   passwords. Does a `VaultClient` class already exist in `src/core/security/`? If not,
   channels-builder should use `process.env` with a documented TODO and Security Engineer
   adds Vault wiring in Wave 4c.

2. **`DualSessionManager` migration path**: `cli.ts` currently instantiates both
   `SessionManager` (SQLite via MindDB) and `JournalSessionStore` (JSONL). After this
   wave, `JournalSessionStore` should be replaced by `SqliteSessionStore` as the secondary
   in `DualSessionManager`. The exact cli.ts wiring change must be agreed before
   memory-builder completes to avoid a merge conflict with cli.ts (owned by channels-builder
   for adapter registration).

3. **`mailparser` vs `@types/mailparser` version alignment**: Confirm `mailparser@3.7.x`
   ships its own types before adding `@types/mailparser` to avoid duplicate-type conflicts.

