# Social Tools Reference

This document covers the post-cleanup social tool surface as of the v5 social-tools cleanup wave.
The six surviving comms tools are outside the scope of this document and were not changed by this
wave.

---

## Table of Contents

1. [Tool Overview](#1-tool-overview)
2. [Supported Platforms](#2-supported-platforms)
3. [Environment Variables](#3-environment-variables)
4. [Mastodon Adapter](#4-mastodon-adapter)
5. [Schedule Dispatcher](#5-schedule-dispatcher)
6. [Usage Examples](#6-usage-examples)
7. [Migration Guide](#7-migration-guide)

---

## 1. Tool Overview

After the v5 social-tools cleanup wave, three social tools are registered:

| Tool name | Purpose |
|---|---|
| `social.twitter-manager` | Post to Twitter using OAuth 2 Bearer token. Unchanged from v4. |
| `social.multi-post` | Post to one or more platforms in a single call. Platforms: `twitter`, `mastodon`, `schedule`. |
| `social.schedule-post` | Schedule a post for future dispatch. Stores the post in the SQLite `scheduled_posts` table. |

The six comms tools remain registered and unchanged. This document does not cover them.

---

## 2. Supported Platforms

The `social.multi-post` tool accepts the following platform values:

| Platform value | Status | Description |
|---|---|---|
| `twitter` | Supported | Posts via the OAuth 2 Bearer path used by `social.twitter-manager`. |
| `mastodon` | Supported | Posts via the real Mastodon statuses API (see section 4). |
| `schedule` | Supported | Hands the post to the schedule dispatcher for future dispatch (see section 5). |

### Removed platforms

**Moltbook** was removed. The owner rejected SUDO-AI's integration request; no Moltbook network
support will be added.

**youtube-community** was removed. YouTube has no public API for posting community posts.
The stub branch that previously existed in `platform-tools.ts` has been deleted.

---

## 3. Environment Variables

All four variables must be present in the environment for full social-tool functionality.
Set them in `.env` (development) or via your secrets manager (production).

### TWITTER_OAUTH2_TOKEN

```
TWITTER_OAUTH2_TOKEN=<bearer token>
```

OAuth 2 Bearer token for the Twitter v2 API. Used by `social.twitter-manager` and by the
`twitter` platform branch inside `social.multi-post`. Obtain this token from the Twitter
Developer Portal under your app's "Keys and Tokens" page (OAuth 2.0 Bearer Token).

This replaces the former OAuth 1.0a key pair (`TWITTER_CONSUMER_KEY`, `TWITTER_CONSUMER_SECRET`,
`TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`), which have been removed.

### MASTODON_INSTANCE

```
MASTODON_INSTANCE=mastodon.social
```

The hostname of the Mastodon instance to post to. Provide the bare hostname without `https://` and
without a trailing slash. The adapter constructs the full URL as
`https://{MASTODON_INSTANCE}/api/v1/statuses`.

### MASTODON_ACCESS_TOKEN

```
MASTODON_ACCESS_TOKEN=<access token>
```

The OAuth access token for your Mastodon account on `MASTODON_INSTANCE`. Obtain this from your
instance's developer settings (Preferences > Development > New Application). The token requires
the `write:statuses` scope.

### YOUTUBE_OAUTH_TOKEN

```
YOUTUBE_OAUTH_TOKEN=<oauth token>
```

OAuth token for YouTube. Retained in `.env.example` for future use by other YouTube-related tools.
Community post dispatch is not supported (no public API exists), but this token may be consumed by
other parts of the system.

---

## 4. Mastodon Adapter

The Mastodon adapter lives at `src/core/tools/builtin/social/mastodon.ts`. It is used internally
by `social.multi-post` when the platform value is `mastodon`.

### Input shape

```typescript
interface MastodonPostOptions {
  status: string;                                                         // required; max 500 characters
  mediaIds?: string[];                                                    // optional Mastodon media attachment IDs
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';            // default: 'public'
  inReplyToId?: string;                                                   // optional; ID of status to reply to
  signal?: AbortSignal;                                                   // optional; for cancellation
}
```

### Return shape

```typescript
interface MastodonPostResult {
  id: string;          // Mastodon status ID
  url: string;         // Permalink URL of the new status
  createdAt: string;   // ISO 8601 timestamp from the server
}
```

### Character limit

The `status` field must be 500 characters or fewer. If the value exceeds 500 characters, the
adapter throws `MastodonError` with HTTP status code 422 before making any network request.

### 429 rate-limit retry

When the Mastodon API responds with HTTP 429:

1. The adapter reads the `X-RateLimit-Reset` response header, which contains a Unix epoch
   timestamp in seconds.
2. It computes `waitMs = (resetEpochSeconds * 1000) - Date.now()`, capped at 300,000 ms (5 minutes).
3. It waits for `waitMs` milliseconds, then retries the request once.
4. If the second attempt also returns 429, the adapter throws `MastodonError(429)` immediately
   without further retry.

This is a single automatic retry at the adapter layer. It is separate from the dispatcher's
per-post retry logic described in section 5.

### Error type

```typescript
class MastodonError extends Error {
  name: 'MastodonError';
  statusCode: number;       // HTTP status code from the Mastodon API
  retryAfterMs?: number;    // Populated when statusCode is 429
}
```

### Logger

The adapter logs under the channel `social:mastodon` using pino via `createLogger('social:mastodon')`.

---

## 5. Schedule Dispatcher

The schedule dispatcher is a daemon (`src/core/social/schedule-dispatcher.ts`) that fires due
scheduled posts through the real platform adapters.

### How it works

- The dispatcher runs on a `setInterval` tick every 60 seconds.
- On each tick it queries the `scheduled_posts` table for posts that are due.
- Due posts are dispatched to the appropriate platform adapter.
- After dispatch the post status is updated in the database.
- The dispatcher is started and stopped by the CLI boot/shutdown sequence (wired in `cli.ts`).

It is not a cron job. It uses `setInterval` directly.

### State machine

```
pending ──► sent        (dispatch succeeded on first attempt)
pending ──► failed      (dispatch failed; retry_count incremented)
failed  ──► sent        (retry succeeded on a subsequent tick)
failed  ──► failed      (retry failed again; retry_count incremented)
pending ──► cancelled   (explicitly cancelled via store.cancel())
```

A post is eligible for dispatch on each tick when:
- `status IN ('pending', 'failed')`
- `retry_count < 3`
- `schedule_time <= now (UTC ISO 8601)`

A post in `failed` status with `retry_count >= 3` is never picked up again. It remains in
`failed` state permanently.

### `scheduled_posts` table

```sql
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id            TEXT     PRIMARY KEY,
  content       TEXT     NOT NULL,
  platforms     TEXT     NOT NULL,                          -- JSON array, e.g. '["twitter","mastodon"]'
  media_urls    TEXT     NOT NULL DEFAULT '[]',             -- JSON array of URL strings
  schedule_time TEXT     NOT NULL,                          -- ISO 8601 UTC
  created_at    TEXT     NOT NULL,                          -- ISO 8601 UTC
  status        TEXT     NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','sent','failed','cancelled')),
  dispatched_at TEXT,                                       -- ISO 8601 UTC; NULL until first dispatch attempt
  error_message TEXT,                                       -- last error string; NULL on success
  retry_count   INTEGER  NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status_time
  ON scheduled_posts(status, schedule_time);
```

Column reference:

| Column | Type | Description |
|---|---|---|
| `id` | TEXT | Primary key. Generated with `genId()`. |
| `content` | TEXT | Post body text. |
| `platforms` | TEXT | JSON-encoded array of platform strings, e.g. `["twitter","mastodon"]`. |
| `media_urls` | TEXT | JSON-encoded array of media URL strings. Empty array `[]` when none. |
| `schedule_time` | TEXT | ISO 8601 UTC datetime at which the post should be dispatched. |
| `created_at` | TEXT | ISO 8601 UTC datetime when the row was inserted. |
| `status` | TEXT | One of `pending`, `sent`, `failed`, `cancelled`. |
| `dispatched_at` | TEXT | ISO 8601 UTC datetime of the most recent dispatch attempt. NULL until attempted. |
| `error_message` | TEXT | Error string from the most recent failed dispatch attempt. NULL otherwise. |
| `retry_count` | INTEGER | Number of failed dispatch attempts. Starts at 0. |

### Dispatcher public API

```typescript
class ScheduleDispatcher {
  constructor(db: Database, mastodonAdapter?: typeof postToMastodon)
  start(): void                  // starts the 60-second setInterval tick
  stop(): void                   // clears the interval
  readonly store: ScheduleStore  // direct access to the SQLite store
  async tick(): Promise<void>    // runs one dispatch cycle (also callable in tests)
}

// Singleton accessors used by tools and the CLI boot sequence
function setDispatcherInstance(d: ScheduleDispatcher): void
function getDispatcherInstance(): ScheduleDispatcher
```

`ScheduleStore` methods: `insert`, `getDue`, `markSent`, `markFailed`, `cancel`, `list`.

---

## 6. Usage Examples

The examples below show the tool name and argument shape. Actual output depends on platform
responses at runtime. All output blocks are illustrative examples, not real responses.

### social.twitter-manager

Post a tweet using the OAuth 2 Bearer token.

```json
{
  "tool": "social.twitter-manager",
  "args": {
    "action": "post",
    "text": "This is a test tweet from SUDO-AI."
  }
}
```

Example output:
```
// EXAMPLE OUTPUT
{
  "id": "1780000000000000001",
  "text": "This is a test tweet from SUDO-AI.",
  "url": "https://twitter.com/user/status/1780000000000000001"
}
```

### social.multi-post — post to a single platform

Post to Mastodon only.

```json
{
  "tool": "social.multi-post",
  "args": {
    "content": "Hello from SUDO-AI on Mastodon.",
    "platforms": ["mastodon"]
  }
}
```

Example output:
```
// EXAMPLE OUTPUT
{
  "mastodon": {
    "id": "109876543210000001",
    "url": "https://mastodon.social/@user/109876543210000001",
    "createdAt": "2026-04-12T10:00:00.000Z"
  }
}
```

### social.multi-post — post to multiple platforms

Post the same content to both Twitter and Mastodon simultaneously.

```json
{
  "tool": "social.multi-post",
  "args": {
    "content": "Cross-posting from SUDO-AI.",
    "platforms": ["twitter", "mastodon"]
  }
}
```

Example output:
```
// EXAMPLE OUTPUT
{
  "twitter": {
    "id": "1780000000000000002",
    "url": "https://twitter.com/user/status/1780000000000000002"
  },
  "mastodon": {
    "id": "109876543210000002",
    "url": "https://mastodon.social/@user/109876543210000002",
    "createdAt": "2026-04-12T10:01:00.000Z"
  }
}
```

### social.schedule-post

Schedule a post for future dispatch. The post is stored in `scheduled_posts` with
`status = 'pending'` and will be dispatched by the daemon when `schedule_time` is reached.

```json
{
  "tool": "social.schedule-post",
  "args": {
    "content": "Scheduled announcement from SUDO-AI.",
    "platforms": ["twitter", "mastodon"],
    "scheduleTime": "2026-04-13T09:00:00Z"
  }
}
```

Example output:
```
// EXAMPLE OUTPUT
{
  "id": "spost_a1b2c3d4e5f6",
  "status": "pending",
  "scheduleTime": "2026-04-13T09:00:00Z",
  "platforms": ["twitter", "mastodon"]
}
```

To cancel a scheduled post before it fires, use the dispatcher store directly (via internal API)
or a future `social.cancel-post` tool if one is added.

---

## 7. Migration Guide

### Removed tools

The following tools were removed in the v5 social-tools cleanup wave and are no longer registered:

| Removed tool | Replacement |
|---|---|
| `comms.twitter-post` | Use `social.twitter-manager` |
| `comms.social-post` | Use `social.multi-post` |

`comms.twitter-post` used Twitter's OAuth 1.0a write path, which has been retired. The OAuth 2
Bearer path used by `social.twitter-manager` is the supported path going forward.

`comms.social-post` previously listed `moltbook` and `youtube-community` as platforms. Both are
gone. Use `social.multi-post` with `platforms: ["twitter"]` or `platforms: ["mastodon"]` instead.

### Environment variable changes

The following variables have been removed from `.env.example` and are no longer used:

- `TWITTER_CONSUMER_KEY`
- `TWITTER_CONSUMER_SECRET`
- `TWITTER_ACCESS_TOKEN`
- `TWITTER_ACCESS_TOKEN_SECRET`
- `MOLTBOOK_API_KEY` (and any other `MOLTBOOK_*` variables)

Ensure these are not referenced in any deployment secrets. They will be ignored if present but
serve no function.

The required variables going forward are documented in section 3.

### Scheduled posts storage

Prior to this wave, scheduled posts were written to `data/scheduled-posts.json`. After this wave,
the store is the SQLite `scheduled_posts` table (section 5). Any posts in the old JSON file are
not automatically migrated. If you have pending posts in that file, re-schedule them using
`social.schedule-post` before deploying this wave.
