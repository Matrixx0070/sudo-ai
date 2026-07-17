/**
 * @file notebooklm/runtime.ts
 * @description Lazy runtime + cron entry points for the NotebookLM annex.
 * Composes on the Drive runtime (getGdriveRuntime) for client/audit/config,
 * adds the notebooklm folder tree. Background-only; never on the agent hot
 * path (invariant 8). No programmatic NotebookLM access (invariant 3).
 */

import { createLogger } from '../shared/logger.js';
import { isNotebookLmEnabled } from './config.js';
import { ensureNotebookLmTree, type NlmFolderMap } from './folders.js';
import type { InspectorBrainCall } from '../gdrive/quarantine.js';

const log = createLogger('notebooklm:runtime');

export interface NlmRuntime {
  client: import('../gdrive/client.js').DriveClient;
  audit: import('../security/audit-trail.js').AuditTrail;
  rootFolderId: string;
  folders: NlmFolderMap;
}

let runtimePromise: Promise<NlmRuntime> | null = null;

export function getNlmRuntime(): Promise<NlmRuntime> {
  if (!runtimePromise) {
    runtimePromise = initRuntime().catch((err) => {
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}

async function initRuntime(): Promise<NlmRuntime> {
  if (!isNotebookLmEnabled()) throw new Error('notebooklm disabled (SUDO_NOTEBOOKLM/SUDO_GDRIVE != 1)');
  const { getGdriveRuntime } = await import('../gdrive/runtime.js');
  const rt = await getGdriveRuntime();
  const rootFolderId = rt.config.rootFolderId!;
  const folders = await ensureNotebookLmTree(rt.client, rootFolderId);
  log.info({ folders: Object.keys(folders).length }, 'notebooklm runtime initialized');
  return { client: rt.client, audit: rt.audit, rootFolderId, folders };
}

// ---------------------------------------------------------------------------
// Inspector brain injection (cheapest-route one-shot, same pattern as gdrive)
// ---------------------------------------------------------------------------

let inspectorBrain: InspectorBrainCall | null = null;
export function setNlmInspectorBrain(fn: InspectorBrainCall): void {
  inspectorBrain = fn;
}

// ---------------------------------------------------------------------------
// Cron entries
// ---------------------------------------------------------------------------

/** Export-lane refresh: compile + export the rolling shapes (E1). */
export async function runNlmExportJob(): Promise<void> {
  if (!isNotebookLmEnabled()) return;
  const rt = await getNlmRuntime();
  const { allShapes } = await import('./shapes.js');
  const { compileAndExport } = await import('./export-lane.js');
  const { auditedJob } = await import('../gdrive/audit.js');

  const ctx = await buildShapeContext(rt);
  for (const shape of allShapes()) {
    if (shape.mode !== 'rolling') continue; // packs are CLI/ritual-triggered
    try {
      await auditedJob(rt.audit, `nlm-export.${shape.id}`, async () => {
        const res = await compileAndExport(rt.client, rt.folders, shape, ctx);
        return { result: undefined, filesTouched: res.docsWritten.map((d) => d.fileId) };
      });
    } catch (err) {
      log.warn({ shape: shape.id, err: String(err) }, 'shape export failed (non-fatal)');
    }
  }
}

/** Returns sweep: E2 pipeline. */
export async function runNlmReturnsJob(): Promise<void> {
  if (!isNotebookLmEnabled()) return;
  const rt = await getNlmRuntime();
  const { processReturnsOnce } = await import('./returns.js');
  const { MindDB } = await import('../memory/db.js');
  const structured = await import('../memory/structured-memory.js');
  const db = new MindDB();
  await processReturnsOnce({
    client: rt.client,
    folders: rt.folders,
    audit: rt.audit,
    chunks: db,
    structured: {
      listMemories: () => structured.listMemories(),
      saveMemory: (m) => structured.saveMemory(m as never),
    },
    inspect: inspectorBrain ? { brainCall: inspectorBrain } : {},
  });
}

/** Rituals refresh: Rituals tab + status file + manifest Doc. */
export async function runNlmRitualsJob(): Promise<void> {
  if (!isNotebookLmEnabled()) return;
  const rt = await getNlmRuntime();
  const { ensureRitualsTab, writeRitualStatus } = await import('./rituals.js');
  const { ensureScorecard } = await import('../gdrive/scorecard.js');
  // The scorecard lives in the gdrive ops folder; reuse its ensurer.
  const { getGdriveRuntime } = await import('../gdrive/runtime.js');
  const grt = await getGdriveRuntime();
  const scorecardId = await ensureScorecard(grt.client, grt.folders);
  await ensureRitualsTab(rt.client, scorecardId);
  await writeRitualStatus(rt.client, rt.folders);
}

async function buildShapeContext(rt: NlmRuntime): Promise<import('./shapes.js').ShapeContext> {
  return {
    now: () => new Date(),
    // Audit notes are cheap + real; reports/open-questions wire fully in N1.
    readAuditNotes: async (n: number) =>
      rt.audit
        .query({ since: new Date(Date.now() - 24 * 3600_000).toISOString(), limit: n })
        .map((r) => `${r.action}: ${r.outcome}`),
    readReports: async () => [],
    readOpenQuestions: async () => [],
  };
}

/** Test hook. */
export function _resetNlmRuntime(): void {
  runtimePromise = null;
}
