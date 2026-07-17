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

/** Export-lane refresh: compile + export all registered shapes (E1 + N1). */
export async function runNlmExportJob(): Promise<void> {
  if (!isNotebookLmEnabled()) return;
  const rt = await getNlmRuntime();
  const { allShapes } = await import('./shapes.js');
  const { registerN1Shapes } = await import('./shapes-n1.js');
  const { compileAndExport } = await import('./export-lane.js');
  const { auditedJob } = await import('../gdrive/audit.js');
  registerN1Shapes();

  const ctx = await buildShapeContext(rt);
  // Auto-refresh shapes (rolling + the F42 architecture pack). Per-item packs
  // (F43 incident, F45 studypack) are CLI-triggered and not in the registry.
  for (const shape of allShapes()) {
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
  const { registerN1Routes, N1_FORCED_EXTERNAL } = await import('./routes-n1.js');
  const { MindDB } = await import('../memory/db.js');
  const structured = await import('../memory/structured-memory.js');
  registerN1Routes();
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
    forcedTier: N1_FORCED_EXTERNAL,
  });
}

/** Rituals refresh: Rituals tab + status file + manifest Doc. */
export async function runNlmRitualsJob(): Promise<void> {
  if (!isNotebookLmEnabled()) return;
  const rt = await getNlmRuntime();
  const { ensureRitualsTab, writeRitualStatus } = await import('./rituals.js');
  const { registerN1Rituals } = await import('./rituals-n1.js');
  registerN1Rituals();
  const { ensureScorecard } = await import('../gdrive/scorecard.js');
  // The scorecard lives in the gdrive ops folder; reuse its ensurer.
  const { getGdriveRuntime } = await import('../gdrive/runtime.js');
  const grt = await getGdriveRuntime();
  const scorecardId = await ensureScorecard(grt.client, grt.folders);
  await ensureRitualsTab(rt.client, scorecardId);
  await writeRitualStatus(rt.client, rt.folders);
}

async function buildShapeContext(rt: NlmRuntime): Promise<import('./shapes.js').ShapeContext> {
  const { getGdriveRuntime } = await import('../gdrive/runtime.js');
  const { readFileSync } = await import('node:fs');
  const { PROJECT_ROOT } = await import('../shared/paths.js');
  const { join } = await import('node:path');
  const grt = await getGdriveRuntime();
  const reportsFolder = grt.folders['ops/reports'];

  return {
    now: () => new Date(),
    readAuditNotes: async (n: number) =>
      rt.audit
        .query({ since: new Date(Date.now() - 24 * 3600_000).toISOString(), limit: n })
        .map((r) => `${r.action}: ${r.outcome}`),
    // Last N daily-report Docs, newest first (F39 brain-radio).
    readReports: async (n: number) => {
      if (!reportsFolder) return [];
      const daily = (await grt.client.listChildren(reportsFolder))
        .filter((f) => f.name.startsWith('daily-'))
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, n);
      const out: string[] = [];
      for (const d of daily) {
        try {
          out.push(await grt.client.filesExport(d.id, 'text/plain'));
        } catch {
          /* skip unreadable */
        }
      }
      return out;
    },
    // Latest ranked open-questions (F52 research target reads [0]).
    readOpenQuestions: async () => {
      if (!reportsFolder) return [];
      const latest = (await grt.client.listChildren(reportsFolder))
        .filter((f) => f.name.startsWith('open-questions-'))
        .sort((a, b) => b.name.localeCompare(a.name))[0];
      if (!latest) return [];
      try {
        const parsed = JSON.parse(await grt.client.filesDownload(latest.id)) as { questions?: string[] };
        return parsed.questions ?? [];
      } catch {
        return [];
      }
    },
    // Repo docs for the F42 architecture pack.
    readFile: (p: string) => {
      try {
        return readFileSync(join(PROJECT_ROOT, p), 'utf-8');
      } catch {
        return null;
      }
    },
    // Live source Docs for the F41 cockpit pointer card.
    readSourceDocs: async () => {
      if (!reportsFolder) return [];
      return (await grt.client.listChildren(reportsFolder))
        .filter((f) => /^(atlas|daily-|self-diff-)/.test(f.name))
        .slice(0, 20)
        .map((f) => ({ name: f.name, id: f.id, url: `https://drive.google.com/open?id=${f.id}` }));
    },
  };
}

/** Test hook. */
export function _resetNlmRuntime(): void {
  runtimePromise = null;
}
