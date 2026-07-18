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
}

export type QueueModeDecision =
  | { action: 'normal' }                          // no active run → run normally
  | { action: 'steer'; tier: SteerTier }          // inject into the active run
  | { action: 'followup' }                         // queue a new turn
  | { action: 'collect' }                          // coalesce in a quiet window
  | { action: 'interrupt' };                        // abort + restart

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
