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

  // Phase 5 riders: deliver due prospective notes (F24) into planning + the
  // report; surface stale/orphaned beliefs (F22/F23); mirror the chronicle.
  const openQuestions: string[] = [];
  try {
    const { deliverDueNotes } = await import('./prospective.js');
    const structured = await import('../memory/structured-memory.js');
    const delivered = await deliverDueNotes({
      listMemories: () => structured.listMemories(),
      saveMemory: (m) => structured.saveMemory(m as never),
    });
    for (const n of delivered) openQuestions.push(`DUE NOTE: ${n.content.slice(0, 160)}`);
  } catch (err) {
    log.warn({ err: String(err) }, 'prospective delivery failed (report continues)');
  }
  try {
    const { loadBeliefs, unhealthyBeliefs } = await import('./beliefs.js');
    for (const b of unhealthyBeliefs(loadBeliefs()).slice(0, 10)) {
      openQuestions.push(`BELIEF ${b.state.toUpperCase()}: ${b.id} (source changed/deleted — re-derivation queued)`);
    }
  } catch {
    /* beliefs optional */
  }
  try {
    const { uploadChronicle } = await import('./chronicle.js');
    await uploadChronicle(rt.client, rt.folders);
  } catch (err) {
    log.warn({ err: String(err) }, 'chronicle upload failed (report continues)');
  }
  try {
    const { uploadDatasets } = await import('./datasets.js');
    await uploadDatasets(rt.client, rt.folders); // F26 mirror rides the report
  } catch (err) {
    log.warn({ err: String(err) }, 'datasets upload failed (report continues)');
  }

  await auditedJob(rt.audit, 'daily-report', async () => {
    const report = await publishDailyReport(rt.client, rt.folders, {
      date,
      auditRows,
      heldQuarantine: held,
      openQuestions,
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

/** Cron entry (weekly): F13 self-diff — memory churn + belief health over 7 days. */
export async function runGdriveSelfDiffJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { readChronicle } = await import('./chronicle.js');
  const { loadBeliefs } = await import('./beliefs.js');
  const { publishSelfDiff, readTopologyLink } = await import('./self-diff.js');
  const { watchDoc } = await import('./comments.js');
  const now = new Date();
  const toDay = now.toISOString().slice(0, 10);
  const fromDay = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const chronicleOps = readChronicle(fromDay, toDay);
  const beliefs = loadBeliefs().beliefs.map((b) => ({
    state: b.state,
    rederiveQueued: b.rederiveQueued,
    trustTier: b.trustTier,
  }));
  await auditedJob(rt.audit, 'self-diff', async () => {
    const res = await publishSelfDiff(rt.client, rt.folders, {
      fromDay,
      toDay,
      chronicleOps,
      beliefs,
      topology: readTopologyLink(),
    });
    watchDoc(res.fileId, `self-diff ${toDay}`);
    return { result: undefined, filesTouched: [res.fileId] };
  });
}

// ---------------------------------------------------------------------------
// Phase 5 — epistemics jobs (F22/F23/F37)
// ---------------------------------------------------------------------------

/** Cron entry (60s): changes-feed sweep — source edits flag beliefs (F22). */
export async function runGdriveChangesJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { runChangesSweep } = await import('./changes.js');
  const result = await runChangesSweep(rt.client);
  if (result.staledBeliefs.length || result.orphanedBeliefs.length) {
    const { emitGdriveAudit } = await import('./audit.js');
    emitGdriveAudit(rt.audit, {
      job: 'changes-sweep',
      outcome: 'success',
      durationMs: 0,
      detail: { staled: result.staledBeliefs, orphaned: result.orphanedBeliefs },
    });
  }
}

/** Cron entry (daily): spaced re-validation sweep (F23). */
export async function runGdriveRevalidationJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { loadBeliefs, saveBeliefs, runRevalidationSweep } = await import('./beliefs.js');
  const graph = loadBeliefs();
  const result = await runRevalidationSweep(graph, async (fileId) => {
    try {
      const meta = await rt.client.filesGet(fileId);
      return { headRevisionId: meta.headRevisionId, trashed: meta.trashed };
    } catch {
      return null; // missing => orphaned
    }
  });
  saveBeliefs(graph);
  const { emitGdriveAudit } = await import('./audit.js');
  emitGdriveAudit(rt.audit, {
    job: 'revalidation',
    outcome: 'success',
    durationMs: 0,
    detail: { passed: result.passed.length, staled: result.staled, orphaned: result.orphaned },
  });
  log.info(result, 'belief re-validation sweep done');
}

/** Cron entry (hourly): world-mirror sweep (F37; per-ref cadence inside). */
export async function runGdriveMirrorJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { runMirrorSweep } = await import('./mirror.js');
  await runMirrorSweep(rt.client, rt.folders, rt.audit, {
    inspect: inspectorBrain ? { brainCall: inspectorBrain } : {},
  });
}

// ---------------------------------------------------------------------------
// Phase 6 — autonomy & continuity jobs (F12/F11/F28/F14)
// ---------------------------------------------------------------------------

/** Cron entry (nightly): the F12 dream cycle. */
export async function runGdriveDreamJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { runDreamCycle } = await import('./dream.js');
  const { loadBrainState } = await import('./checkpoint.js');
  const { MindDB } = await import('../memory/db.js');
  const structured = await import('../memory/structured-memory.js');
  const db = new MindDB();
  await runDreamCycle({
    client: rt.client,
    folders: rt.folders,
    audit: rt.audit,
    chunks: db,
    structured: {
      listMemories: () => structured.listMemories(),
      saveMemory: (m) => structured.saveMemory(m as never),
    },
    brainCall: inspectorBrain ?? undefined,
    localCounter: loadBrainState().counter,
    restoreCheck: async () => {
      const deps = await buildCheckpointDeps();
      const { runRestoreCheck } = await import('./checkpoint.js');
      return runRestoreCheck(deps);
    },
    checkpoint: async () => {
      const deps = await buildCheckpointDeps();
      const { runCheckpoint } = await import('./checkpoint.js');
      const result = await runCheckpoint(deps);
      return { counter: result.manifest.counter };
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 7 — experimentation & ops (F38 drain rides the dream window; F26
// datasets mirror rides the daily report)
// ---------------------------------------------------------------------------

/** Cron entry (dream window): drain the curiosity buffer, budget-bounded (F38). */
export async function runGdriveCuriosityJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  if (!inspectorBrain) {
    log.debug('curiosity drain skipped — no brain injected yet');
    return;
  }
  const rt = await getGdriveRuntime();
  const { drainCuriosity } = await import('./curiosity.js');
  const { MindDB } = await import('../memory/db.js');
  const structured = await import('../memory/structured-memory.js');
  const db = new MindDB();
  await drainCuriosity(rt.client, rt.folders, {
    research: inspectorBrain, // one-shot cheapest-route call; bounded by caps
    chunks: db,
    structured: {
      listMemories: () => structured.listMemories(),
      saveMemory: (m) => structured.saveMemory(m as never),
    },
    inspectorBrain,
    dailyBudget: Number(process.env['SUDO_GDRIVE_CURIOSITY_BUDGET']) || 5,
  });
}

/** Cron entry (daily): deep-freeze eviction sweep over episodic day-logs (F11). */
export async function runGdriveFreezeJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { runFreezeSweep } = await import('./deep-freeze.js');
  const { WORKSPACE_DIR } = await import('../shared/paths.js');
  const { join } = await import('node:path');
  const maxAge = Number(process.env['SUDO_GDRIVE_FREEZE_AGE_DAYS']) || 30;
  const frozen = await runFreezeSweep(rt.client, rt.folders, join(WORKSPACE_DIR, 'memory'), maxAge);
  if (frozen.length) {
    const { emitGdriveAudit } = await import('./audit.js');
    emitGdriveAudit(rt.audit, {
      job: 'freeze-sweep',
      outcome: 'success',
      durationMs: 0,
      filesTouched: frozen.map((f) => f.driveFileId),
      bytes: frozen.reduce((a, f) => a + f.bytes, 0),
      detail: { count: frozen.length },
    });
  }
}

/** Cron entry (5min): blackboard heartbeat + peer visibility (F14). */
export async function runGdriveBlackboardJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { writeMyStatus, readPeers } = await import('./blackboard.js');
  await writeMyStatus(rt.client, rt.folders, { status: 'running' });
  const peers = await readPeers(rt.client, rt.folders);
  if (peers.length) log.debug({ peers: peers.map((p) => p.instanceId) }, 'blackboard peers');
}

/** Cron entry (daily): embedding-index snapshot (F28). */
export async function runGdriveIndexSnapshotJob(): Promise<void> {
  if (!isGdriveEnabled()) return;
  const rt = await getGdriveRuntime();
  const { uploadIndexSnapshot } = await import('./index-snapshot.js');
  const { loadHmacKey, loadEncKey } = await import('./keys.js');
  const { MindDB } = await import('../memory/db.js');
  const db = new MindDB();
  await uploadIndexSnapshot(rt.client, rt.folders, db.db, {
    hmacKey: loadHmacKey(),
    encKey: loadEncKey(),
  });
}

// ---------------------------------------------------------------------------
// F35 — loop-side auto-hibernation handler
// ---------------------------------------------------------------------------

let _autoHibernateInFlight = false;

/**
 * Called (fire-and-forget) from the agent loop's iteration boundary via the
 * setAutoHibernate seam. Serializes the loop snapshot to Drive so the task can
 * resume on another machine. Coalesced: at most one write in flight at a time
 * (the loop fires on a coarse iteration cadence anyway).
 */
export function runGdriveAutoHibernate(snap: {
  sessionId: string;
  plan: string;
  stepCursor: number;
  toolResultDigests: string[];
}): void {
  if (!isGdriveEnabled() || process.env['SUDO_GDRIVE_AUTOHIBERNATE'] !== '1') return;
  if (_autoHibernateInFlight) return;
  _autoHibernateInFlight = true;
  void (async () => {
    try {
      const rt = await getGdriveRuntime();
      const { hibernateTask } = await import('./hibernate.js');
      const { loadHmacKey, loadEncKey } = await import('./keys.js');
      const { loadBrainState } = await import('./checkpoint.js');
      // taskId must be filename-safe (^[\w-]{1,64}$) — sanitize the sessionId.
      const taskId = snap.sessionId.replace(/[^\w-]/g, '_').slice(0, 64) || 'session';
      await hibernateTask(
        rt.client,
        rt.folders,
        { hmacKey: loadHmacKey(), encKey: loadEncKey() },
        {
          taskId,
          plan: snap.plan,
          stepCursor: snap.stepCursor,
          toolResultDigests: snap.toolResultDigests,
          pendingApprovals: [],
          brainCounter: loadBrainState().counter,
        },
      );
      log.debug({ taskId, step: snap.stepCursor }, 'auto-hibernated loop state');
    } catch (err) {
      log.debug({ err: String(err) }, 'auto-hibernate failed (non-fatal)');
    } finally {
      _autoHibernateInFlight = false;
    }
  })();
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
