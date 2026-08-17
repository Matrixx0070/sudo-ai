/**
 * @file queue-modes.ts
 * @description GW-5 — per-session queue modes + the mid-run dispatch decision.
 *
 * When a message arrives for a session that already has an active run, the mode
 * decides what happens:
 *  - steer      inject into the current run after the current tool call
 *  - followup   queue a new turn (today's serialize behavior)
 *  - collect    coalesce during a quiet window, then follow up as one turn
 *  - interrupt  abort the current run and start a new turn with the message
 *
 * Hard exclusions (from the spec, non-negotiable):
 *  - Registered control commands are NEVER steered/debounced — they intercept
 *    immediately (handled upstream; decideQueueMode is only reached for non-command
 *    turns, but we assert it defensively).
 *  - MEDIA messages are NEVER steered — attachment metadata must not detach from
 *    its turn (OpenClaw learned this). Media → followup.
 *  - Trust-tier mixing guard: a steer that would DOWNGRADE an owner run (untrusted
 *    content steering an owner turn) is rerouted to followup — never mixed mid-run.
 *
 * The effective steer tier is min(run, steered); steering is only allowed when the
 * steered tier is at least as trusted as the run tier (so the run tier is preserved).
 *
 * Config: a per-session override on top of a per-channel default on top of the
 * global default (SUDO_QUEUE_MODE_DEFAULT). Persisted as a small JSON map.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { SteerTier } from '../agent/steer-buffer.js';
import { TIER_RANK } from '../agent/steer-buffer.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:queue-modes');

export type QueueMode = 'steer' | 'followup' | 'collect' | 'interrupt';
const VALID: readonly QueueMode[] = ['steer', 'followup', 'collect', 'interrupt'];

export function isQueueMode(v: unknown): v is QueueMode {
  return typeof v === 'string' && (VALID as readonly string[]).includes(v);
}

/**
 * The spec's global default is `steer`. Because prod mid-run semantics cannot be
 * verified against a live daemon in this change, the SHIPPED default is read from
 * SUDO_QUEUE_MODE_DEFAULT and, when unset, is `followup` (today's serialize
 * behavior) — an explicit, posture-registered conservative default. Set
 * SUDO_QUEUE_MODE_DEFAULT=steer to adopt the spec default once live-verified.
 */
export function globalDefaultMode(env: NodeJS.ProcessEnv = process.env): QueueMode {
  const raw = env['SUDO_QUEUE_MODE_DEFAULT'];
  return isQueueMode(raw) ? raw : 'followup';
}

/**
 * How the OWNER's message is handled when it arrives DURING an active run
 * (owner directive 2026-08-17). Only the owner tier is ever treated specially;
 * an untrusted message can never interrupt or spawn a concurrent run.
 *
 *  - 'concurrent' (DEFAULT): keep the running task going in the BACKGROUND and
 *    answer the new message in parallel on a side session — the owner gets a
 *    reply without interrupting the ongoing work.
 *  - 'interrupt': abort the running loop and run the new message instead.
 *  - 'queue': fall back to the configured per-session queue mode (steer/followup).
 *
 * Selected by SUDO_OWNER_MIDRUN; legacy SUDO_OWNER_INTERRUPTS=0 maps to 'queue'.
 */
export type OwnerMidRunMode = 'concurrent' | 'interrupt' | 'queue';
export function ownerMidRunMode(env: NodeJS.ProcessEnv = process.env): OwnerMidRunMode {
  const raw = (env['SUDO_OWNER_MIDRUN'] ?? '').trim().toLowerCase();
  if (raw === 'interrupt' || raw === 'concurrent' || raw === 'queue') return raw;
  if (env['SUDO_OWNER_INTERRUPTS'] === '0') return 'queue'; // legacy opt-out
  return 'concurrent';
}

/**
 * When an owner message interrupts a running loop, immediately send this short
 * acknowledgement so the owner SEES the loop was interrupted (rather than the
 * bot silently aborting and only replying to the new message later). On by
 * default; set SUDO_OWNER_INTERRUPT_ACK=0 to suppress the ack.
 */
export const INTERRUPT_ACK_TEXT = '⏸️ Interrupting the current task to handle your new message…';
export function interruptAckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_OWNER_INTERRUPT_ACK'] !== '0';
}

export interface QueueModeDecisionInput {
  /** The configured mode for this session (already resolved from overrides). */
  mode: QueueMode;
  /** Is a run currently active for this session? */
  activeRun: boolean;
  /** Does the message carry media/attachments? */
  isMedia: boolean;
  /** Is the message a registered control command? (should be handled upstream) */
  isCommand: boolean;
  /** Trust tier of the active run. */
  runTier: SteerTier;
  /** Trust tier of the incoming message. */
  msgTier: SteerTier;
  /**
   * How to treat an OWNER-tier message during an active run (computed by the
   * caller from {@link ownerMidRunMode}). 'concurrent' → answer in parallel while
   * the run continues; 'interrupt' → abort + run new; 'queue'/undefined → use the
   * configured queue mode. Never applies to untrusted messages.
   */
  ownerMidRun?: OwnerMidRunMode;
}

export type QueueModeDecision =
  | { action: 'normal' }                          // no active run → run normally
  | { action: 'steer'; tier: SteerTier }          // inject into the active run
  | { action: 'followup' }                         // queue a new turn
  | { action: 'collect' }                          // coalesce in a quiet window
  | { action: 'interrupt' }                         // abort + restart
  | { action: 'concurrent' };                       // answer in parallel; run keeps going

/**
 * Decide how to handle an inbound message given the session's mode + context.
 * Pure — no I/O.
 */
export function decideQueueMode(input: QueueModeDecisionInput): QueueModeDecision {
  // No active run → the message starts a fresh turn (normal path).
  if (!input.activeRun) return { action: 'normal' };

  // Registered commands never steer — they intercept immediately upstream. If one
  // reaches here, treat as followup (do NOT fold it into a running turn).
  if (input.isCommand) return { action: 'followup' };

  // Media never steers — keep the attachment attached to its own turn.
  if (input.isMedia) return { action: 'followup' };

  // Owner mid-run handling takes precedence over the configured queue mode, but
  // only for the OWNER tier (an untrusted message never interrupts or spawns a
  // concurrent run — it falls through to the tier-guarded mode handling).
  if (input.msgTier === 'owner' && input.ownerMidRun && input.ownerMidRun !== 'queue') {
    return input.ownerMidRun === 'interrupt' ? { action: 'interrupt' } : { action: 'concurrent' };
  }

  switch (input.mode) {
    case 'interrupt':
      return { action: 'interrupt' };
    case 'collect':
      return { action: 'collect' };
    case 'followup':
      return { action: 'followup' };
    case 'steer': {
      // Tier-mixing guard: steering must not DOWNGRADE the run. Allowed only when
      // the message is at least as trusted as the run; else reroute to followup.
      if (TIER_RANK[input.msgTier] < TIER_RANK[input.runTier]) {
        log.warn(
          { runTier: input.runTier, msgTier: input.msgTier },
          'GW-5 steer would downgrade run trust — rerouting to followup (never mix tiers mid-run)',
        );
        return { action: 'followup' };
      }
      // Effective tier is min(run, steered) — since msgTier >= runTier, that's runTier.
      return { action: 'steer', tier: input.runTier };
    }
    default:
      return { action: 'followup' };
  }
}

// --------------------------------------------------------------------------
// Per-session / per-channel mode config (persisted JSON)
// --------------------------------------------------------------------------

interface QueueModeConfig {
  /** Per-channel default mode. */
  channels?: Record<string, QueueMode>;
  /** Per-session (channel:peerId) override. */
  sessions?: Record<string, QueueMode>;
}

export class QueueModeStore {
  private readonly file: string;
  private cfg: QueueModeConfig;

  constructor(dir: string = path.join(process.env['DATA_DIR'] ?? 'data', 'queue-modes')) {
    this.file = path.join(dir, 'queue-modes.json');
    this.cfg = this.load();
  }

  private load(): QueueModeConfig {
    try {
      if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, 'utf8')) as QueueModeConfig;
    } catch (err) {
      log.warn({ err: String(err) }, 'queue-mode config unreadable — using defaults');
    }
    return {};
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.cfg));
      renameSync(tmp, this.file);
    } catch (err) {
      log.error({ err: String(err) }, 'queue-mode config write failed');
    }
  }

  /** Resolve the effective mode: session override → channel default → global. */
  resolve(channel: string, peerId: string, env: NodeJS.ProcessEnv = process.env): QueueMode {
    const sessionKey = `${channel}:${peerId}`;
    return this.cfg.sessions?.[sessionKey]
      ?? this.cfg.channels?.[channel]
      ?? globalDefaultMode(env);
  }

  setChannelMode(channel: string, mode: QueueMode): void {
    this.cfg.channels = { ...this.cfg.channels, [channel]: mode };
    this.persist();
  }

  setSessionMode(channel: string, peerId: string, mode: QueueMode): void {
    this.cfg.sessions = { ...this.cfg.sessions, [`${channel}:${peerId}`]: mode };
    this.persist();
  }

  clearSessionMode(channel: string, peerId: string): void {
    if (this.cfg.sessions) { delete this.cfg.sessions[`${channel}:${peerId}`]; this.persist(); }
  }
}

let _store: QueueModeStore | null = null;
export function getQueueModeStore(): QueueModeStore {
  if (!_store) _store = new QueueModeStore();
  return _store;
}
export function __resetQueueModeStoreForTest(): void { _store = null; }
