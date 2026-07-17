/**
 * @file gdrive/dream.ts
 * @description F12 — the nightly dream cycle: the engine earlier phases
 * schedule work onto. Runs offline on the cheapest brain route (injected;
 * the pipeline is fully functional brain-less), never touches the hot loop.
 *
 * Pipeline (each stage fail-open, results aggregated):
 *   1. RE-DERIVE  — beliefs queued by F22/F23: re-fetch source, re-inspect
 *                   (F18), re-ingest via the memory API, refresh the belief.
 *   2. CONFIRM    — dead-end candidates older than the maturity window are
 *                   confirmed (LLM judge when available; age-based default)
 *                   and surfaced to planning (F33), with a matchDeadEnds
 *                   pre-check on each re-derivation "plan".
 *   3. RECONCILE  — manifest divergence: remote counter ahead of local =>
 *                   hydrate-apply (newest-wins), then checkpoint local state.
 *   4. AGENDA     — write the open-questions file that seeds tomorrow's
 *                   self-improve queue and feeds the self-report (F3).
 *
 * NOTE: episodic distillation of the day's conversations already exists in
 * the repo (AutoDream, 6h cadence) — deliberately NOT duplicated here (D-o-c
 * in the status doc). This dream handles the Drive-epistemics workload.
 */

import { createLogger } from '../shared/logger.js';
import type { AuditTrail } from '../security/audit-trail.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { ChunkStoreLike, StructuredStoreLike } from './brain-serializer.js';
import type { InspectorBrainCall } from './quarantine.js';
import { inspectContent } from './quarantine.js';
import { loadBeliefs, saveBeliefs, upsertBelief } from './beliefs.js';
import { listDeadEnds, confirmDeadEnd, matchDeadEnds, uploadDeadEnds } from './dead-ends.js';
import { listHeldQuarantine } from './report.js';
import { chunkText } from './inbox.js';
import { emitGdriveAudit } from './audit.js';
import { isGdrivePaused } from './canary.js';

const log = createLogger('gdrive:dream');

const DEAD_END_MATURITY_MS = 24 * 3600_000;

export interface DreamDeps {
  client: DriveClient;
  folders: FolderIdMap;
  audit: AuditTrail | null;
  chunks: ChunkStoreLike;
  structured: StructuredStoreLike;
  brainCall?: InspectorBrainCall;
  localCounter: number;
  /** Injected F2 hooks so dream doesn't own checkpoint policy. */
  restoreCheck: () => Promise<{ action: string }>;
  checkpoint: () => Promise<{ counter: number }>;
  now?: () => Date;
}

export interface DreamReport {
  rederived: string[];
  rederiveSkippedDeadEnd: string[];
  confirmedDeadEnds: string[];
  reconciled: string;
  openQuestions: string[];
}

export async function runDreamCycle(deps: DreamDeps): Promise<DreamReport> {
  const report: DreamReport = {
    rederived: [],
    rederiveSkippedDeadEnd: [],
    confirmedDeadEnds: [],
    reconciled: 'none',
    openQuestions: [],
  };
  if (isGdrivePaused()) {
    log.warn('gdrive PAUSED — dream cycle skipped');
    return report;
  }
  const started = Date.now();
  const now = deps.now?.() ?? new Date();

  // -- 1. RE-DERIVE queued beliefs ------------------------------------------
  try {
    const graph = loadBeliefs();
    const queued = graph.beliefs.filter((b) => b.rederiveQueued && b.state !== 'deprecated');
    for (const belief of queued.slice(0, 20)) {
      // Planner pre-check (F33): a re-derivation that matches a confirmed
      // dead end is skipped and surfaced instead of re-entered.
      const plan = `re-derive belief ${belief.id} from sources ${belief.sources.map((s) => s.fileId).join(',')}`;
      if (matchDeadEnds(plan).length > 0) {
        report.rederiveSkippedDeadEnd.push(belief.id);
        continue;
      }
      try {
        let allText = '';
        let ok = true;
        const freshSources: Array<{ fileId: string; revisionId?: string }> = [];
        for (const source of belief.sources) {
          const meta = await deps.client.filesGet(source.fileId).catch(() => null);
          if (!meta || meta.trashed) {
            ok = false;
            break;
          }
          const text =
            meta.mimeType === 'application/vnd.google-apps.document'
              ? await deps.client.filesExport(source.fileId, 'text/markdown')
              : await deps.client.filesDownload(source.fileId);
          allText += `${text}\n`;
          freshSources.push({ fileId: source.fileId, revisionId: meta.headRevisionId });
        }
        if (!ok || !allText.trim()) continue;
        // Re-inspect: changed source content is untrusted again (F18).
        const verdict = await inspectContent(allText, deps.brainCall ? { brainCall: deps.brainCall } : {});
        if (verdict.verdict === 'hold') {
          report.openQuestions.push(`Re-derivation HELD for ${belief.id} (injection risk ${verdict.riskScore})`);
          continue;
        }
        for (const piece of chunkText(allText)) {
          deps.chunks.storeChunk(piece, belief.chunkPathPrefix, 'file', { role: 'user' });
        }
        upsertBelief(graph, {
          id: belief.id,
          chunkPathPrefix: belief.chunkPathPrefix,
          sources: freshSources,
          trustTier: belief.trustTier,
          now: now.toISOString(),
        });
        report.rederived.push(belief.id);
      } catch (err) {
        log.warn({ belief: belief.id, err: String(err) }, 're-derivation failed — stays queued');
      }
    }
    saveBeliefs(graph);
  } catch (err) {
    log.warn({ err: String(err) }, 'dream re-derivation stage failed');
  }

  // -- 2. CONFIRM matured dead-end candidates -------------------------------
  try {
    for (const candidate of listDeadEnds('candidate')) {
      if (now.getTime() - Date.parse(candidate.createdAt) < DEAD_END_MATURITY_MS) continue;
      let confirm = true;
      if (deps.brainCall) {
        try {
          const raw = await deps.brainCall(
            `A tool-repetition abort was recorded. Summary: "${candidate.summary}". Cause: "${candidate.cause}". ` +
              'Should this be a PERMANENT dead-end rule (the same approach must never be retried without justification)? ' +
              'Answer only YES or NO.',
          );
          confirm = /\bYES\b/i.test(raw.slice(0, 200));
        } catch {
          /* judge unavailable — age-based confirm stands */
        }
      }
      if (confirm) {
        await confirmDeadEnd(candidate.id, deps.structured);
        report.confirmedDeadEnds.push(candidate.id);
      }
    }
    if (report.confirmedDeadEnds.length) await uploadDeadEnds(deps.client, deps.folders);
  } catch (err) {
    log.warn({ err: String(err) }, 'dream dead-end stage failed');
  }

  // -- 3. RECONCILE divergence (newest-wins, then push our state) ------------
  try {
    const restore = await deps.restoreCheck();
    const push = await deps.checkpoint();
    report.reconciled = `${restore.action} -> counter ${push.counter}`;
  } catch (err) {
    report.reconciled = `failed: ${String(err).slice(0, 200)}`;
    log.warn({ err: String(err) }, 'dream reconcile stage failed');
  }

  // -- 4. AGENDA — the RANKED open-questions file (G-F52RANK) ----------------
  // Ranked so F52's research desk can pick the single highest-priority
  // question: orphaned (source gone) > stale (re-derive queued) > quarantine
  // hold. The flat `questions` array preserves rank order for back-compat.
  try {
    const graph = loadBeliefs();
    const scored: Array<{ question: string; score: number }> = [];
    for (const b of graph.beliefs.filter((x) => x.rederiveQueued).slice(0, 20)) {
      const score = b.state === 'orphaned' ? 3 : b.state === 'stale' ? 2 : 1;
      scored.push({ question: `Belief ${b.id} still ${b.state} — re-derivation pending`, score });
    }
    for (const held of await listHeldQuarantine(deps.client, deps.folders)) {
      scored.push({ question: `Quarantine HOLD needs review: ${held}`, score: 1 });
    }
    scored.sort((a, b) => b.score - a.score);
    report.openQuestions = scored.map((s) => s.question);
    const opsFolder = deps.folders['ops/reports'];
    if (opsFolder) {
      const name = `open-questions-${now.toISOString().slice(0, 10)}.json`;
      const body = JSON.stringify(
        { generatedAt: now.toISOString(), questions: report.openQuestions, ranked: scored },
        null,
        2,
      );
      const existing = (await deps.client.listChildren(opsFolder)).find((f) => f.name === name);
      if (existing) await deps.client.filesUpdate(existing.id, {}, { mimeType: 'application/json', body });
      else await deps.client.filesCreate({ name, parents: [opsFolder] }, { mimeType: 'application/json', body });
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'dream agenda stage failed');
  }

  emitGdriveAudit(deps.audit, {
    job: 'dream-cycle',
    outcome: 'success',
    durationMs: Date.now() - started,
    detail: {
      rederived: report.rederived.length,
      skippedDeadEnd: report.rederiveSkippedDeadEnd.length,
      confirmedDeadEnds: report.confirmedDeadEnds.length,
      reconciled: report.reconciled,
      openQuestions: report.openQuestions.length,
    },
  });
  log.info(
    { rederived: report.rederived.length, confirmed: report.confirmedDeadEnds.length, reconciled: report.reconciled },
    'dream cycle complete',
  );
  return report;
}
