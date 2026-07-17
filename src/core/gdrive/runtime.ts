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

// ---------------------------------------------------------------------------
// Phase 4 — human-interface jobs (F3/F4/F6/F7/F30)
// ---------------------------------------------------------------------------

function principalEmails(): string[] {
  return (process.env['GDRIVE_PRINCIPAL_EMAILS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function saEmail(credPath?: string): Promise<string> {
  return (await resolveServiceAccountEmail(credPath)) ?? 'unknown-sa';
}

/** Cron entry (nightly): daily self-report + telemetry scorecard row. */
export async function runGdriveDailyReportJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { publishDailyReport, listHeldQuarantine } = await import('./report.js');
  const { ensureScorecard, appendTelemetryRow } = await import('./scorecard.js');
  const { watchDoc } = await import('./comments.js');

  const date = new Date().toISOString().slice(0, 10);
  const sinceIso = new Date(Date.now() - 24 * 3600_000).toISOString();
  const auditRows = rt.audit.query({ since: sinceIso, limit: 2000 });
  const held = await listHeldQuarantine(rt.client, rt.folders);

  await auditedJob(rt.audit, 'daily-report', async () => {
    const report = await publishDailyReport(rt.client, rt.folders, {
      date,
      auditRows,
      heldQuarantine: held,
    });
    watchDoc(report.fileId, `daily report ${date}`); // F6 watches it
    return { result: undefined, filesTouched: [report.fileId] };
  });

  // F4 telemetry row (sync-observability rider included). Token/cost figures
  // read from mind.db api_call_log (read-only aggregation).
  await auditedJob(rt.audit, 'scorecard-telemetry', async () => {
    const sheetId = await ensureScorecard(rt.client, rt.folders);
    const { MindDB } = await import('../memory/db.js');
    const mind = new MindDB();
    const agg = mind.db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens),0) AS tin, COALESCE(SUM(completion_tokens),0) AS tout,
                COALESCE(SUM(estimated_cost_usd),0) AS cost,
                COALESCE(SUM(cache_read_tokens),0) AS cread, COUNT(*) AS calls,
                COALESCE(SUM(CASE WHEN success=0 THEN 1 ELSE 0 END),0) AS errs
         FROM api_call_log WHERE called_at >= ?`,
      )
      .get(sinceIso) as { tin: number; tout: number; cost: number; cread: number; calls: number; errs: number };
    const depth = rt.client.queueDepth;
    await appendTelemetryRow(rt.client, sheetId, {
      date,
      tokensIn: agg.tin,
      tokensOut: agg.tout,
      estCostUsd: Number(agg.cost.toFixed(4)),
      cacheHitRate: agg.tin > 0 ? Number((agg.cread / agg.tin).toFixed(4)) : 0,
      toolCalls: agg.calls,
      errorCount: agg.errs,
      syncLagS: 0, // populated when the sync queue tracks lag (F11)
      divergenceCount: 0, // populated by dream-cycle divergence handling (F12)
      queueDepthInteractive: depth.interactive,
      queueDepthBackground: depth.background,
    });
    return { result: undefined };
  });
}

/** Cron entry (30s default): control-panel Config/PAUSE poll (F7). */
export async function runGdriveControlPanelJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { ensureControlPanel, pollControlPanel } = await import('./control-panel.js');
  const sheetId = await ensureControlPanel(rt.client, rt.folders);
  const result = await pollControlPanel(rt.client, sheetId);
  if (result.applied.length || result.rejected.length) {
    log.info(result, 'control panel poll applied changes');
    emitControlAudit(rt, result);
  }
}

function emitControlAudit(rt: GdriveRuntime, result: { applied: string[]; rejected: Array<{ key: string; reason: string }> }): void {
  void import('./audit.js').then(({ emitGdriveAudit }) =>
    emitGdriveAudit(rt.audit, {
      job: 'control-panel',
      outcome: result.rejected.length && !result.applied.length ? 'denied' : 'success',
      durationMs: 0,
      detail: { applied: result.applied, rejected: result.rejected },
    }),
  );
}

/** Cron entry (2min default): comment-driven corrections (F6). */
export async function runGdriveCommentsJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { pollComments } = await import('./comments.js');
  const structured = await import('../memory/structured-memory.js');
  await pollComments({
    client: rt.client,
    structured: {
      listMemories: () => structured.listMemories(),
      saveMemory: (m) => structured.saveMemory(m as never),
    },
    principalEmails: principalEmails(),
    serviceAccountEmail: await saEmail(rt.config.credentialsPath),
  });
}

/** Cron entry (nightly): regenerate the brain atlas (F30). */
export async function runGdriveAtlasJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { publishAtlas } = await import('./atlas.js');
  const { watchDoc } = await import('./comments.js');
  const { MindDB } = await import('../memory/db.js');
  const structured = await import('../memory/structured-memory.js');
  const mind = new MindDB();
  await auditedJob(rt.audit, 'atlas', async () => {
    const fileId = await publishAtlas(rt.client, rt.folders, {
      chunks: mind.getActiveChunks(50_000),
      structured: (await structured.listMemories()) as never,
    });
    watchDoc(fileId, 'brain atlas');
    return { result: undefined, filesTouched: [fileId] };
  });
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
