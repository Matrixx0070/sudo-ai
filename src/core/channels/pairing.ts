/**
 * @file pairing.ts
 * @description GW-6 — pairing codes for unknown senders.
 *
 * A non-allowlisted sender on a `pairing`-policy channel is not silently dropped;
 * they receive a short one-time code and the owner approves it out-of-band. The
 * triggering message is NOT processed until approved (it arrived pre-trust), and
 * the code reply is a PURE ADAPTER-LEVEL response — zero LLM, never an agent turn
 * (the prompt-injection surface stays closed).
 *
 * Channel-generic: the store keys on {channel, accountId, peerId}. Telegram wires
 * it first; other channels reuse the same interface.
 *
 * Guards (OpenClaw parity):
 *  - Unambiguous alphabet (no 0/O/1/I/L), 8 chars.
 *  - 1-hour expiry; a peer with a live pending request gets the SAME code back
 *    (one code per expiry window), never a fresh one.
 *  - Max 3 pending per {channel, accountId}; further NEW peers → capped (drop).
 *  - Per-peer request rate limit (SlidingWindowLimiter) so a peer cannot spam the
 *    pairing path.
 *  - firstMessagePreview stored truncated to 128 chars + control-stripped; it is
 *    only ever DISPLAYED to the owner (never executed, never sent to an LLM).
 *
 * Pure over an injected directory + clock so caps, expiry, and approve/deny are
 * unit-testable without real time or a real filesystem root.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { SlidingWindowLimiter } from '../gateway/rate-limit.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:pairing');

/** Unambiguous alphabet — excludes 0 O 1 I L to avoid transcription errors. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
export const PAIRING_MAX_PENDING_PER_ACCOUNT = 3;
export const PAIRING_PREVIEW_MAX = 128;

export interface PendingPairing {
  channel: string;
  accountId: string;
  peerId: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  firstMessagePreview: string;
}

/** A peer approved for a channel account (persisted, survives restart). */
export interface PairedPeer {
  channel: string;
  accountId: string;
  peerId: string;
  approvedAt: number;
}

export type PairingRequestOutcome =
  | { status: 'created'; code: string; expiresAt: number }
  | { status: 'pending-exists'; code: string; expiresAt: number }
  | { status: 'already-paired' }
  | { status: 'capped' }
  | { status: 'rate-limited'; retryAfterMs: number };

interface PairingState {
  pending: PendingPairing[];
  paired: PairedPeer[];
}

/** Generate an unambiguous N-char code using a uniform CSPRNG. */
export function generatePairingCode(len: number = PAIRING_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Truncate + strip control chars so a preview is safe to DISPLAY to the owner. */
export function sanitizePreview(text: string): string {
  const stripped = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, PAIRING_PREVIEW_MAX);
}

export class PairingManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly limiter: SlidingWindowLimiter;
  private state: PairingState;

  constructor(opts: { dir: string; now?: () => number; requestLimit?: number; requestWindowMs?: number }) {
    this.file = path.join(opts.dir, 'pairing.json');
    this.now = opts.now ?? Date.now;
    // Default: at most 5 pairing requests per peer per 10 min.
    this.limiter = new SlidingWindowLimiter(
      { limit: opts.requestLimit ?? 5, windowMs: opts.requestWindowMs ?? 600_000, lockoutMs: 0 },
      this.now,
    );
    this.state = this.load();
  }

  private load(): PairingState {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PairingState>;
        return { pending: parsed.pending ?? [], paired: parsed.paired ?? [] };
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'pairing store unreadable — starting empty');
    }
    return { pending: [], paired: [] };
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);
    } catch (err) {
      log.error({ err: String(err) }, 'pairing store write failed');
    }
  }

  /** Drop expired pending entries (called before every read/write path). */
  private purgeExpired(): void {
    const t = this.now();
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((p) => p.expiresAt > t);
    if (this.state.pending.length !== before) this.persist();
  }

  private key(channel: string, accountId: string): string {
    return `${channel}:${accountId}`;
  }

  isPaired(channel: string, accountId: string, peerId: string): boolean {
    return this.state.paired.some(
      (p) => p.channel === channel && p.accountId === accountId && p.peerId === peerId,
    );
  }

  /** Peers approved for a channel account — merge into an adapter allowlist on boot. */
  pairedPeers(channel: string, accountId?: string): string[] {
    return this.state.paired
      .filter((p) => p.channel === channel && (accountId === undefined || p.accountId === accountId))
      .map((p) => p.peerId);
  }

  listPending(channel?: string, accountId?: string): PendingPairing[] {
    this.purgeExpired();
    return this.state.pending.filter(
      (p) => (channel === undefined || p.channel === channel)
        && (accountId === undefined || p.accountId === accountId),
    );
  }

  /**
   * An unknown sender requested access. Idempotent within the expiry window:
   * a peer with a live pending request gets the SAME code back.
   */
  requestPairing(input: {
    channel: string;
    accountId: string;
    peerId: string;
    preview: string;
  }): PairingRequestOutcome {
    this.purgeExpired();
    const { channel, accountId, peerId } = input;

    if (this.isPaired(channel, accountId, peerId)) return { status: 'already-paired' };

    // Already have a live code for this exact peer → return it (one per window).
    const existing = this.state.pending.find(
      (p) => p.channel === channel && p.accountId === accountId && p.peerId === peerId,
    );
    if (existing) return { status: 'pending-exists', code: existing.code, expiresAt: existing.expiresAt };

    // Per-peer request flood control (before allocating a new code / slot).
    const verdict = this.limiter.record(`${channel}:${accountId}:${peerId}`);
    if (!verdict.allowed) return { status: 'rate-limited', retryAfterMs: verdict.retryAfterMs };

    // Cap pending NEW peers per account.
    const pendingForAccount = this.state.pending.filter(
      (p) => p.channel === channel && p.accountId === accountId,
    ).length;
    if (pendingForAccount >= PAIRING_MAX_PENDING_PER_ACCOUNT) return { status: 'capped' };

    const t = this.now();
    const entry: PendingPairing = {
      channel, accountId, peerId,
      code: generatePairingCode(),
      createdAt: t,
      expiresAt: t + PAIRING_EXPIRY_MS,
      firstMessagePreview: sanitizePreview(input.preview),
    };
    this.state.pending.push(entry);
    this.persist();
    log.info({ channel, accountId, peerId: '(redacted)', key: this.key(channel, accountId) }, 'pairing code issued to unknown sender');
    return { status: 'created', code: entry.code, expiresAt: entry.expiresAt };
  }

  /** Owner/admin approves a code → peer added to the paired set. Returns the entry. */
  approve(code: string): PendingPairing | null {
    this.purgeExpired();
    const idx = this.state.pending.findIndex((p) => p.code === code.toUpperCase());
    if (idx < 0) return null;
    const entry = this.state.pending[idx]!;
    this.state.pending.splice(idx, 1);
    if (!this.isPaired(entry.channel, entry.accountId, entry.peerId)) {
      this.state.paired.push({
        channel: entry.channel, accountId: entry.accountId, peerId: entry.peerId, approvedAt: this.now(),
      });
    }
    this.persist();
    log.warn({ channel: entry.channel, accountId: entry.accountId }, 'pairing approved — peer added to allowlist');
    return entry;
  }

  /** Owner/admin denies a code → pending entry removed. Returns true if it existed. */
  deny(code: string): boolean {
    this.purgeExpired();
    const idx = this.state.pending.findIndex((p) => p.code === code.toUpperCase());
    if (idx < 0) return false;
    this.state.pending.splice(idx, 1);
    this.persist();
    return true;
  }
}

// --------------------------------------------------------------------------
// Process singleton (shared by the Telegram adapter, owner command, admin route)
// --------------------------------------------------------------------------

let _singleton: PairingManager | null = null;

/** Lazily build/return the process-wide PairingManager rooted at DATA_DIR/pairing. */
export function getPairingManager(): PairingManager {
  if (_singleton) return _singleton;
  const dataDir = process.env['DATA_DIR'] ?? 'data';
  _singleton = new PairingManager({ dir: path.join(dataDir, 'pairing') });
  return _singleton;
}

/** Test-only: drop the singleton so a fresh DATA_DIR is picked up. */
export function __resetPairingSingletonForTest(): void {
  _singleton = null;
}
