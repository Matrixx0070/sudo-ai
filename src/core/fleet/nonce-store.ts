/**
 * @file src/core/fleet/nonce-store.ts
 * @description Gap #28c slice 4 — single-use, TTL'd nonce store for the
 * registration challenge round-trip. Closes the slice-1-documented replay
 * window: an attacker who captured a valid `POST /api/fleet/register` body
 * could re-submit it within ±5 minutes (the registration's `ts` window).
 *
 * **Flow:**
 *   1. Device calls `GET /api/fleet/challenge?deviceId=<id>`.
 *      Registrar generates a 32-byte random nonce, stores it keyed by
 *      `deviceId` with a 5-minute expiry.
 *   2. Device builds its `RegistrationPayload` with `nonce` set to the
 *      received value, signs the canonical bytes, POSTs to `/register`.
 *   3. Registrar verifies signature, then `consume()` atomically removes
 *      the nonce from the store. Replay is now impossible — the second
 *      attempt finds no nonce + 400.
 *
 * **Storage:** SQLite-backed (slice-4 follow-up). A `dbPath` argument
 * persists nonces in `fleet.db` alongside `fleet_devices` + the command
 * queue; omitting it falls back to `:memory:` so unit tests stay fast.
 *
 * Persistence closes the slice-4-final WEAKEST POINT: with the in-memory
 * map, a registrar running behind a load balancer with N processes could
 * not consume a challenge issued by a peer process — the device's GET
 * landed on process A, the POST on process B, and B had no record. The
 * SQLite-WAL writer-lock serializes `DELETE … WHERE … RETURNING` across
 * processes, so whichever process loses the race gets an empty result
 * and returns `false`, which is the correct anti-replay behavior.
 *
 * **Atomic consume:** `DELETE FROM fleet_nonces WHERE device_id=? AND
 * nonce=? AND expires_at_ms>? RETURNING device_id` runs as a single
 * write. Two parallel processes seeing the same captured nonce both
 * issue the DELETE; SQLite serializes them, one returns a row and the
 * other returns empty. This is fundamentally why we don't try to
 * SELECT-then-DELETE inside a JS-side transaction — the prepared
 * `DELETE … RETURNING` is one statement, atomic by SQLite's writer lock.
 *
 * **TTL sweep:** every `consume`/`issue` opportunistically prunes
 * expired rows. No background timer — keeps the module side-effect-free
 * at import time and avoids interfering with `process.exit()`/test
 * teardown. Sweep failures are swallowed because the consume statement
 * already excludes expired rows via its `expires_at_ms > ?` predicate.
 */

import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

/** Default 5-minute TTL. Matches the registration replay-window. */
export const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000;

export interface NonceStoreOptions {
  /**
   * Absolute path to the SQLite file. When omitted, the store uses an
   * in-memory database — useful for unit tests, harmful in production
   * where multi-process consume would silently lose state. cli.ts §8.5c
   * always passes the shared `fleet.db` path.
   */
  dbPath?: string;
  /** Override the TTL (testing). */
  ttlMs?: number;
  /** Override the clock (testing). */
  now?: () => number;
  /** Override the nonce generator (testing). Defaults to 32-byte randomBytes. */
  generator?: () => string;
}

export class NonceStore {
  private readonly db: Database.Database;
  private readonly issueStmt: Database.Statement;
  private readonly consumeStmt: Database.Statement;
  private readonly sweepStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generator: () => string;

  constructor(opts: NonceStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_NONCE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.generator = opts.generator ?? defaultGenerator;

    this.db = new Database(opts.dbPath ?? ':memory:');
    // WAL is a no-op for :memory: (SQLite ignores it) and is the right
    // posture for the on-disk `fleet.db` — matches RegistryStore /
    // CommandQueue which already opened the same file in WAL.
    try { this.db.pragma('journal_mode = WAL'); } catch { /* :memory: */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_nonces (
        device_id      TEXT PRIMARY KEY,
        nonce          TEXT NOT NULL,
        expires_at_ms  INTEGER NOT NULL
      )
    `);

    // INSERT OR REPLACE — re-issuing for the same device overwrites the
    // prior outstanding nonce. The previous in-memory store did the same.
    this.issueStmt = this.db.prepare(`
      INSERT INTO fleet_nonces (device_id, nonce, expires_at_ms)
      VALUES (@deviceId, @nonce, @expiresAtMs)
      ON CONFLICT(device_id) DO UPDATE SET
        nonce         = excluded.nonce,
        expires_at_ms = excluded.expires_at_ms
    `);

    // Atomic check + consume in one SQL statement. The DELETE only
    // fires when the device + nonce + non-expired predicate all match,
    // and RETURNING tells us whether a row was actually removed.
    // SQLite serializes concurrent writers via the WAL writer lock, so
    // a captured nonce racing across processes loses to whoever DELETEs
    // first — the loser sees `[]`.
    this.consumeStmt = this.db.prepare(`
      DELETE FROM fleet_nonces
      WHERE device_id = @deviceId
        AND nonce = @nonce
        AND expires_at_ms > @nowMs
      RETURNING device_id
    `);

    this.sweepStmt = this.db.prepare(`
      DELETE FROM fleet_nonces WHERE expires_at_ms <= @cutoff
    `);
    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM fleet_nonces`);
  }

  /**
   * Issue a fresh nonce for `deviceId`. Overwrites any outstanding one —
   * the device might re-fetch a nonce (lost the previous response, retry
   * after backoff). The latest issued nonce wins.
   *
   * Returns the nonce + the expiry timestamp the device should respect.
   */
  issue(deviceId: string): { nonce: string; expiresAtMs: number } {
    this.sweepExpired();
    const nonce = this.generator();
    const expiresAtMs = this.now() + this.ttlMs;
    this.issueStmt.run({ deviceId, nonce, expiresAtMs });
    return { nonce, expiresAtMs };
  }

  /**
   * Atomically check + consume a nonce for `deviceId`. Returns `true` if
   * the nonce matched + was not expired; `false` otherwise. The matching
   * row is REMOVED on success so a second attempt with the same nonce
   * always fails (replay defense), even across processes pointed at the
   * same `dbPath`.
   */
  consume(deviceId: string, nonce: string): boolean {
    this.sweepExpired();
    const rows = this.consumeStmt.all({
      deviceId,
      nonce,
      nowMs: this.now(),
    }) as Array<{ device_id: string }>;
    return rows.length > 0;
  }

  /** Current outstanding count (tests + diagnostics). */
  size(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  /** Close the underlying SQLite handle. Safe to call multiple times. */
  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  /**
   * Drop expired rows. Called opportunistically from `issue`/`consume`.
   * Failures are swallowed because `consume` already filters expired
   * rows in its WHERE clause — sweep is just bookkeeping to keep the
   * table small.
   */
  private sweepExpired(): void {
    try {
      this.sweepStmt.run({ cutoff: this.now() });
    } catch { /* best-effort */ }
  }
}

function defaultGenerator(): string {
  return randomBytes(32).toString('base64url');
}
