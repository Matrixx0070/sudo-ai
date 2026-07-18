/**
 * @file run-registry.ts
 * @description GW-5/GW-11 — the active-run registry.
 *
 * Tracks which sessions currently have a run in flight, keyed by the channel
 * serialization key (`channel:peerId`). GW-5 uses it to know (a) whether a run is
 * active for a session and (b) the run's trust tier + how to abort it, so a
 * mid-run message can be steered / interrupted correctly. GW-11 builds its
 * per-session one-run guarantee and lane accounting on top of the same registry.
 *
 * In-memory, single-process. A run entry lives from beginRun() to endRun().
 */

import { createLogger } from '../shared/logger.js';
import type { SteerTier } from './steer-buffer.js';

const log = createLogger('agent:run-registry');

export interface ActiveRun {
  /** Channel serialization key: `channel:peerId`. */
  key: string;
  /** The loop sessionId this run drives (steer buffer is keyed by this). */
  sessionId: string;
  /** Trust tier of the run (owner-initiated vs untrusted). */
  tier: SteerTier;
  /** ms epoch the run began. */
  startedAt: number;
  /** Request a clean abort of this run (wired to the steering channel). */
  abort?: (reason: string) => void;
}

export class RunRegistry {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  /** Is a run currently active for this session key? */
  isActive(key: string): boolean { return this.runs.has(key); }

  /** The active run for a session key, if any. */
  get(key: string): ActiveRun | undefined { return this.runs.get(key); }

  /** Number of runs in flight (all sessions). */
  get activeCount(): number { return this.runs.size; }

  /** Register a run start. Returns the ActiveRun record. */
  beginRun(fields: { key: string; sessionId: string; tier: SteerTier; abort?: (reason: string) => void }): ActiveRun {
    const run: ActiveRun = { ...fields, startedAt: this.now() };
    this.runs.set(fields.key, run);
    log.debug({ key: fields.key, tier: fields.tier }, 'run registered');
    return run;
  }

  /** Mark a run finished. Safe to call for an unknown key. */
  endRun(key: string): void {
    if (this.runs.delete(key)) log.debug({ key }, 'run ended');
  }
}

let _singleton: RunRegistry | null = null;
export function getRunRegistry(): RunRegistry {
  if (!_singleton) _singleton = new RunRegistry();
  return _singleton;
}
export function __resetRunRegistryForTest(): void { _singleton = null; }
