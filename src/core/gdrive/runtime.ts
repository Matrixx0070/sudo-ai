/**
 * @file gdrive/runtime.ts
 * @description Lazy singleton runtime + cron entry points for the Drive layer.
 *
 * cli.ts wiring stays minimal: it registers the heartbeat CronJob and routes
 * the `gdrive:heartbeat` systemEvent here via dynamic import. Everything else
 * (config validation, client, bootstrap, audit) initializes lazily on first
 * job fire, and total failure is contained — the agent loop never depends on
 * anything in this module (prime directive 1/10).
 */

import { createLogger } from '../shared/logger.js';
import { AuditTrail } from '../security/audit-trail.js';
import { loadGdriveConfig, isGdriveEnabled } from './config.js';
import { DriveClient } from './client.js';
import { ensureFolderTree } from './bootstrap.js';
import { auditedJob } from './audit.js';
import { writeHeartbeat } from './heartbeat.js';
import type { FolderIdMap, GdriveConfig } from './types.js';

const log = createLogger('gdrive:runtime');

export interface GdriveRuntime {
  config: GdriveConfig;
  client: DriveClient;
  folders: FolderIdMap;
  audit: AuditTrail;
}

let runtimePromise: Promise<GdriveRuntime> | null = null;

/**
 * Get (or lazily initialize) the shared Drive runtime. Throws when disabled
 * or misconfigured — callers are background jobs that treat failure as
 * queue-and-retry, never the hot path.
 */
export function getGdriveRuntime(): Promise<GdriveRuntime> {
  if (!runtimePromise) {
    runtimePromise = initRuntime().catch((err) => {
      // Reset so a later fire retries a transient bootstrap failure instead
      // of pinning a rejected promise forever.
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}

async function initRuntime(): Promise<GdriveRuntime> {
  const config = loadGdriveConfig();
  if (!config.enabled) throw new Error('gdrive disabled (SUDO_GDRIVE != 1)');
  const client = new DriveClient(config);
  const audit = new AuditTrail();
  const folders = await auditedJob(audit, 'bootstrap', async () => {
    const map = await ensureFolderTree(client, config.rootFolderId!);
    return { result: map, filesTouched: Object.values(map) };
  });
  log.info({ folders: Object.keys(folders).length }, 'gdrive runtime initialized');
  return { config, client, folders, audit };
}

/** Cron entry: one heartbeat write. No-op (logged) when disabled. */
export async function runGdriveHeartbeatJob(): Promise<void> {
  if (!isGdriveEnabled()) {
    log.debug('gdrive heartbeat skipped — SUDO_GDRIVE != 1');
    return;
  }
  const rt = await getGdriveRuntime();
  await auditedJob(rt.audit, 'heartbeat', async () => {
    const fileId = await writeHeartbeat(rt.client, rt.folders);
    return { result: undefined, filesTouched: [fileId] };
  });
}

// ---------------------------------------------------------------------------
// F2 — checkpoint / restore jobs
// ---------------------------------------------------------------------------

/**
 * Build the snapshot dependencies against the REAL memory backends. Lazy
 * dynamic imports keep gdrive out of any static import graph that boots the
 * agent loop; note the direction gdrive -> memory is fine (the hot-path guard
 * forbids only memory -> gdrive).
 */
async function buildCheckpointDeps(): Promise<import('./checkpoint.js').CheckpointDeps> {
  const rt = await getGdriveRuntime();
  const { loadHmacKey, loadEncKey } = await import('./keys.js');
  const { MindDB } = await import('../memory/db.js');
  const structured = await import('../memory/structured-memory.js');
  const hmacKey = loadHmacKey();
  let encKey: Buffer | undefined;
  try {
    encKey = loadEncKey();
  } catch {
    // Optional until a zone-1 record exists; pushBrain fails loudly if one
    // appears without a key.
    encKey = undefined;
  }
  const db = new MindDB();
  return {
    client: rt.client,
    folders: rt.folders,
    keys: { hmacKey, encKey },
    audit: rt.audit,
    snapshot: {
      chunks: db,
      structured: {
        listMemories: () => structured.listMemories(),
        saveMemory: (m) => structured.saveMemory(m as never),
      },
    },
  };
}

/** Cron entry: push a brain checkpoint (F2 write-behind mirror). */
export async function runGdriveCheckpointJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const { runCheckpoint } = await import('./checkpoint.js');
  const deps = await buildCheckpointDeps();
  const result = await runCheckpoint(deps);
  log.info(
    { counter: result.manifest.counter, uploaded: result.uploadedBlobs, skipped: result.skippedBlobs },
    'brain checkpoint pushed',
  );
}

/** Boot entry: hydrate-and-apply when the remote brain is ahead (F2). */
export async function runGdriveRestoreCheckJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const { runRestoreCheck } = await import('./checkpoint.js');
  const deps = await buildCheckpointDeps();
  const outcome = await runRestoreCheck(deps);
  log.info({ outcome: outcome.action }, 'gdrive restore check complete');
}

// ---------------------------------------------------------------------------
// F1/F18 — inbox ingestion job
// ---------------------------------------------------------------------------

import type { InspectorBrainCall } from './quarantine.js';

let inspectorBrain: InspectorBrainCall | null = null;

/**
 * cli.ts injects the CHEAPEST-route brain call here once the brain exists
 * (same pattern as AutoDream's brainCall). Until injected, quarantine runs
 * deterministic-only — it never fails open.
 */
export function setGdriveInspectorBrain(fn: InspectorBrainCall): void {
  inspectorBrain = fn;
}

/** Cron entry: one knowledge-inbox sweep (F1 -> F18 -> memory API). */
export async function runGdriveInboxJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { processInboxOnce } = await import('./inbox.js');
  const { MindDB } = await import('../memory/db.js');
  const structured = await import('../memory/structured-memory.js');
  const config = rt.config;
  const db = new MindDB();
  const saEmail = await resolveServiceAccountEmail(config.credentialsPath);
  const result = await processInboxOnce({
    client: rt.client,
    folders: rt.folders,
    audit: rt.audit,
    chunks: db,
    structured: {
      listMemories: () => structured.listMemories(),
      saveMemory: (m) => structured.saveMemory(m as never),
    },
    trustCtx: {
      serviceAccountEmail: saEmail ?? 'unknown-sa',
      principalEmails: (process.env['GDRIVE_PRINCIPAL_EMAILS'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    inspect: inspectorBrain ? { brainCall: inspectorBrain } : {},
  });
  if (result.processed.length || result.held.length || result.aborted) {
    log.info(result, 'inbox sweep complete');
  }
}

async function resolveServiceAccountEmail(credPath?: string): Promise<string | null> {
  if (!credPath) return null;
  try {
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(credPath, 'utf-8')) as { client_email?: string };
    return parsed.client_email ?? null;
  } catch {
    return null;
  }
}

/** Cron entry: monthly kill-and-restore rehearsal (F2 rider). */
export async function runGdriveRestoreDrillJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const { runRestoreDrill } = await import('./checkpoint.js');
  const deps = await buildCheckpointDeps();
  const result = await runRestoreDrill(deps);
  if (!result.ok) {
    log.error({ divergent: result.divergent }, 'RESTORE DRILL FAILED — backup does not reproduce local brain');
  }
}

/** Test hook: reset the singleton between cases. */
export function _resetGdriveRuntime(): void {
  runtimePromise = null;
}
