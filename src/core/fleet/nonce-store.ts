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
 * **Storage:** in-memory. Slice 4 is single-registrar-process; a registrar
 * restart loses outstanding nonces, but legitimate devices just GET a new
 * one on their next registration attempt. Persistent (SQLite-backed) nonces
 * are a follow-up if multi-process registrar lands.
 *
 * **TTL sweep:** every `consume`/`issue` opportunistically prunes expired
 * entries. No background timer — keeps the module side-effect-free at
 * import time and avoids interfering with `process.exit()`/test teardown.
 */

import { randomBytes } from 'node:crypto';

/** A single nonce, with the time it expires. */
interface NonceEntry {
  nonce: string;
  expiresAtMs: number;
}

/** Default 5-minute TTL. Matches the registration replay-window. */
export const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000;

export interface NonceStoreOptions {
  /** Override the TTL (testing). */
  ttlMs?: number;
  /** Override the clock (testing). */
  now?: () => number;
  /** Override the nonce generator (testing). Defaults to 32-byte randomBytes. */
  generator?: () => string;
}

export class NonceStore {
  private readonly entries: Map<string, NonceEntry> = new Map();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generator: () => string;

  constructor(opts: NonceStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_NONCE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.generator = opts.generator ?? defaultGenerator;
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
    this.entries.set(deviceId, { nonce, expiresAtMs });
    return { nonce, expiresAtMs };
  }

  /**
   * Atomically check + consume a nonce for `deviceId`. Returns `true` if
   * the nonce matched + was not expired; `false` otherwise. The matching
   * entry is REMOVED on success so a second attempt with the same nonce
   * always fails (replay defense).
   */
  consume(deviceId: string, nonce: string): boolean {
    this.sweepExpired();
    const entry = this.entries.get(deviceId);
    if (!entry) return false;
    if (entry.nonce !== nonce) return false;
    if (this.now() > entry.expiresAtMs) {
      this.entries.delete(deviceId);
      return false;
    }
    this.entries.delete(deviceId);
    return true;
  }

  /** Current outstanding count (tests + diagnostics). */
  size(): number { return this.entries.size; }

  /** Drop expired entries. Called opportunistically from `issue`/`consume`. */
  private sweepExpired(): void {
    const cutoff = this.now();
    for (const [k, v] of this.entries.entries()) {
      if (v.expiresAtMs < cutoff) this.entries.delete(k);
    }
  }
}

function defaultGenerator(): string {
  return randomBytes(32).toString('base64url');
}
