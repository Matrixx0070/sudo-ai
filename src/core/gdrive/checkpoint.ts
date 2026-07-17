/**
 * @file gdrive/checkpoint.ts
 * @description F2 — brain checkpoint (write-behind mirror) + startup restore
 * check + restore drill (rider).
 *
 * Checkpoint: collect snapshot -> pushBrain with counter+1 -> persist local
 * brain state. Restore check: hydrate remote; apply ONLY when the remote
 * counter is ahead of local (cross-machine continuity); integrity refusals
 * audit as 'denied' and keep local state. Both are background cron jobs —
 * never on the agent hot path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { AuditTrail } from '../security/audit-trail.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { BrainKeys } from './keys.js';
import { pushBrain, hydrateBrain, type PushResult } from './blob-store.js';
import { ManifestVerifyError } from './manifest.js';
import { emitGdriveAudit } from './audit.js';
import {
  collectBrainSnapshot,
  applyBrainSnapshot,
  type ApplyReport,
  type BrainSnapshotDeps,
} from './brain-serializer.js';

const log = createLogger('gdrive:checkpoint');

// ---------------------------------------------------------------------------
// Local brain state (counter continuity across restarts)
// ---------------------------------------------------------------------------

export interface BrainState {
  counter: number;
  lastPushAt?: string;
  lastRestoreAt?: string;
}

export function brainStatePath(): string {
  return dataPath('gdrive', 'brain-state.json');
}

export function loadBrainState(): BrainState {
  try {
    return JSON.parse(readFileSync(brainStatePath(), 'utf-8')) as BrainState;
  } catch {
    return { counter: 0 };
  }
}

export function saveBrainState(state: BrainState): void {
  const p = brainStatePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Checkpoint (push)
// ---------------------------------------------------------------------------

export interface CheckpointDeps {
  client: DriveClient;
  folders: FolderIdMap;
  keys: BrainKeys;
  snapshot: BrainSnapshotDeps;
  audit: AuditTrail | null;
  now?: () => Date;
}

export async function runCheckpoint(deps: CheckpointDeps): Promise<PushResult> {
  const started = Date.now();
  const state = loadBrainState();
  const inputs = await collectBrainSnapshot(deps.snapshot);
  const createdAt = (deps.now?.() ?? new Date()).toISOString();
  try {
    const result = await pushBrain(deps.client, deps.folders, inputs, deps.keys, {
      counter: state.counter + 1,
      createdAt,
    });
    saveBrainState({ ...state, counter: result.manifest.counter, lastPushAt: createdAt });

    // F31 — chronicle: derive add/update/deprecate ops from the manifest
    // transition (every synced memory mutation, no memory-API instrumentation).
    try {
      const { appendChronicle, opsFromManifestDiff } = await import('./chronicle.js');
      const prevPath = dataPath('gdrive', 'last-manifest.json');
      let prev = null;
      try {
        prev = JSON.parse(readFileSync(prevPath, 'utf-8'));
      } catch {
        /* first checkpoint */
      }
      appendChronicle(opsFromManifestDiff(prev, result.manifest, createdAt), createdAt.slice(0, 10));
      writeFileSync(prevPath, JSON.stringify(result.manifest), { mode: 0o600 });
    } catch (chronErr) {
      log.warn({ err: String(chronErr) }, 'chronicle append failed (checkpoint still recorded)');
    }
    emitGdriveAudit(deps.audit, {
      job: 'checkpoint',
      outcome: 'success',
      durationMs: Date.now() - started,
      bytes: result.bytes,
      filesTouched: result.manifest.entries.map((e) => e.blob),
      detail: {
        counter: result.manifest.counter,
        uploaded: result.uploadedBlobs,
        skipped: result.skippedBlobs,
        filteredZone0: result.filteredZone0,
      },
    });
    return result;
  } catch (err) {
    emitGdriveAudit(deps.audit, {
      job: 'checkpoint',
      outcome: 'error',
      durationMs: Date.now() - started,
      detail: { error: String(err).slice(0, 500) },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Restore check (startup / cross-machine)
// ---------------------------------------------------------------------------

export type RestoreOutcome =
  | { action: 'applied'; report: ApplyReport; remoteCounter: number }
  | { action: 'up-to-date'; localCounter: number; remoteCounter: number }
  | { action: 'no-remote' }
  | { action: 'refused'; reason: string };

/**
 * Hydrate-and-apply when the remote brain is ahead. Integrity failures refuse
 * (audit outcome 'denied') and local state is untouched — tamper never
 * degrades to best-effort.
 */
export async function runRestoreCheck(deps: CheckpointDeps): Promise<RestoreOutcome> {
  const started = Date.now();
  const state = loadBrainState();
  let hydrated;
  try {
    hydrated = await hydrateBrain(deps.client, deps.folders, deps.keys);
  } catch (err) {
    if (err instanceof ManifestVerifyError && /no remote manifest/.test(err.message)) {
      return { action: 'no-remote' };
    }
    emitGdriveAudit(deps.audit, {
      job: 'restore-check',
      outcome: 'denied',
      durationMs: Date.now() - started,
      detail: { reason: String(err).slice(0, 500) },
    });
    log.error({ err: String(err) }, 'REFUSED remote brain — integrity failure; local state kept');
    return { action: 'refused', reason: String(err) };
  }

  if (hydrated.manifest.counter <= state.counter) {
    return {
      action: 'up-to-date',
      localCounter: state.counter,
      remoteCounter: hydrated.manifest.counter,
    };
  }

  const report = await applyBrainSnapshot(hydrated.blobs, deps.snapshot);
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  saveBrainState({ ...state, counter: hydrated.manifest.counter, lastRestoreAt: nowIso });
  emitGdriveAudit(deps.audit, {
    job: 'restore-check',
    outcome: 'success',
    durationMs: Date.now() - started,
    detail: { remoteCounter: hydrated.manifest.counter, ...report },
  });
  log.info({ counter: hydrated.manifest.counter, ...report }, 'remote brain applied');
  return { action: 'applied', report, remoteCounter: hydrated.manifest.counter };
}

// ---------------------------------------------------------------------------
// Restore drill (rider: backups you don't test don't exist)
// ---------------------------------------------------------------------------

export interface DrillResult {
  ok: boolean;
  /** logicalPaths present locally but missing/different in the hydrated copy. */
  divergent: string[];
  remoteCounter: number;
}

/**
 * Kill-and-restore rehearsal WITHOUT touching live state: hydrate into memory
 * and diff against a fresh local snapshot. Scheduled monthly; result audited
 * (scorecard row when F4 lands).
 */
export async function runRestoreDrill(deps: CheckpointDeps): Promise<DrillResult> {
  const started = Date.now();
  const [hydrated, localInputs] = await Promise.all([
    hydrateBrain(deps.client, deps.folders, deps.keys),
    collectBrainSnapshot(deps.snapshot),
  ]);
  const divergent: string[] = [];
  for (const input of localInputs) {
    if (input.zone === 0) continue;
    const remote = hydrated.blobs.get(input.logicalPath);
    if (!remote || !remote.equals(input.content)) divergent.push(input.logicalPath);
  }
  const ok = divergent.length === 0;
  emitGdriveAudit(deps.audit, {
    job: 'restore-drill',
    outcome: ok ? 'success' : 'failure',
    durationMs: Date.now() - started,
    detail: { divergent, remoteCounter: hydrated.manifest.counter },
  });
  return { ok, divergent, remoteCounter: hydrated.manifest.counter };
}
