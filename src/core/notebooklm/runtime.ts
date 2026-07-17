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

// E4 self-runner + judge injections (background-only, cheapest routes).
let selfAnswer: import('./probe.js').SelfAnswerFn | null = null;
export function setNlmSelfAnswer(fn: import('./probe.js').SelfAnswerFn): void {
  selfAnswer = fn;
}
let judgeCall: import('./probe.js').JudgeFn | null = null;
export function setNlmJudge(fn: import('./probe.js').JudgeFn): void {
  judgeCall = fn;
}

// ---------------------------------------------------------------------------
// Cron entries
// ---------------------------------------------------------------------------

/** Export-lane refresh: compile + export all registered shapes (E1 + N1). */
export async function runNlmExportJob(): Promise<void> {
  if (!isNotebookLmEnabled()) return;
  // F64: while a succession is in flight, autonomous broadcast is PAUSED.
  if ((await import('./succession.js')).isSuccessionPaused()) {
    log.info('nlm export skipped — succession gate paused');
    return;
  }
  const rt = await getNlmRuntime();
  const { allShapes } = await import('./shapes.js');
  const { registerN1Shapes } = await import('./shapes-n1.js');
  const { registerN3Shapes } = await import('./shapes-n3.js');
  const { compileAndExport } = await import('./export-lane.js');
  const { auditedJob } = await import('../gdrive/audit.js');
  registerN1Shapes();
  registerN3Shapes();

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
  // E4: register probe-answer routes + the known probe sets + judge so
  // F40/F50/F58 returns route to the comparator instead of memory.
  const { registerProbeRoutes, registerProbeSet, setProbeJudge } = await import('./probe-route.js');
  const { ALL_PROBE_SETS } = await import('./probe-sets.js');
  registerProbeRoutes();
  for (const set of ALL_PROBE_SETS) registerProbeSet(set);
  if (judgeCall) setProbeJudge(judgeCall);
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

/**
 * E4 verify job: the self reader answers every probe set (recorded for later
 * comparison), then the OFFLINE gates run — F61 Feynman (blocking), F63 identity
 * pulse (alert vs baseline), F68 curriculum ladder. Publishes a verify report
 * and the probe question sheets to notebooklm/probes. No external paste needed
 * for the gates; the F40/F50/F58 comparisons arrive later via the returns job.
 */
export async function runNlmVerifyJob(): Promise<{ ran: boolean; blocked: string[]; alerts: string[] }> {
  if (!isNotebookLmEnabled()) return { ran: false, blocked: [], alerts: [] };
  if ((await import('./succession.js')).isSuccessionPaused()) {
    log.info('nlm verify skipped — succession gate paused');
    return { ran: false, blocked: [], alerts: [] };
  }
  if (!selfAnswer) {
    log.warn('nlm verify: no self-answer injected — skipping');
    return { ran: false, blocked: [], alerts: [] };
  }
  const rt = await getNlmRuntime();
  const { runProbeSelf } = await import('./probe.js');
  const { feynmanGate, identityPulse, evaluateLadder } = await import('./probe-gates.js');
  const { ALL_PROBE_SETS, F50_LEGIBILITY, F63_IDENTITY, CORE_LADDER } = await import('./probe-sets.js');
  const { saveSelfRun, ensureBaseline, loadBaseline } = await import('./probe-store.js');
  const { resolveJudgeModel } = await import('../../llm/judge.js');
  const { HEADER_SENTENCE } = await import('./export-lane.js');

  const studentRoute = 'sudo/cheap'; // the self reader's route (student under test)
  const blocked: string[] = [];
  const alerts: string[] = [];
  const lines: string[] = [`> ${HEADER_SENTENCE}`, '', '# E4 verify report', '', `judge: \`${resolveJudgeModel()}\``, ''];

  for (const set of ALL_PROBE_SETS) {
    const run = await runProbeSelf(set, selfAnswer, { studentRoute });
    saveSelfRun(run);
  }

  // F61 — blocking Feynman gate on the legibility core.
  const legRun = (await import('./probe-store.js')).loadSelfRun(F50_LEGIBILITY.id);
  if (legRun) {
    const g = feynmanGate(F50_LEGIBILITY, legRun);
    lines.push(`- F61 Feynman: ${g.pass ? 'PASS' : 'BLOCK'} — ${g.reason}`);
    if (g.blocked) blocked.push('F61');
  }

  // F63 — identity pulse vs pinned baseline.
  const idRun = (await import('./probe-store.js')).loadSelfRun(F63_IDENTITY.id);
  if (idRun) {
    const baseline = loadBaseline(F63_IDENTITY.id) ?? ensureBaseline(idRun);
    const p = identityPulse(F63_IDENTITY, idRun, baseline);
    lines.push(`- F63 identity: ${p.alert ? 'ALERT' : 'stable'} — ${p.reason}`);
    if (p.alert) alerts.push('F63');
  }

  // F68 — curriculum ladder from rung 0.
  const rung0Run = (await import('./probe-store.js')).loadSelfRun(CORE_LADDER.rungs[0]!.set.id);
  if (rung0Run) {
    const r = evaluateLadder(CORE_LADDER, 0, rung0Run);
    lines.push(`- F68 ladder: ${r.reason}`);
  }

  const folder = rt.folders['notebooklm/probes'];
  if (folder) {
    await rt.client.filesCreate(
      { name: 'verify-report.md', parents: [folder], mimeType: 'text/markdown' },
      { mimeType: 'text/markdown', body: lines.join('\n') },
    );
  }
  log.info({ blocked, alerts }, 'nlm verify job complete');
  return { ran: true, blocked, alerts };
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

/**
 * F64 succession job: detect a model-generation change and drive the gate —
 * pause (checkSuccession) → seal a successor pack → once acked, run the identity
 * pulse (F63) → resume when acked+pulsed. Each step is best-effort/idempotent;
 * the job is safe to run on a cadence. Autonomous jobs consult isSuccessionPaused().
 */
export async function runNlmSuccessionJob(): Promise<{ phase: string }> {
  if (!isNotebookLmEnabled()) return { phase: 'disabled' };
  const succ = await import('./succession.js');
  const { currentModelGeneration } = await import('../../llm/aliases.js');
  const check = succ.checkSuccession(currentModelGeneration());
  const state = succ.loadSuccessionState();
  const phase = state?.phase ?? 'stable';

  // Just paused → seal the successor pack (needs an enc key + inputs).
  if (check.changed || (phase === 'paused' && !state?.ackToken)) {
    try {
      const { loadEncKey } = await import('../gdrive/keys.js');
      const encKey = loadEncKey();
      const [directives, learnings, openQuestions] = await Promise.all([
        (async () => {
          try {
            const m = (await import('../gdrive/study-of-principal.js')).loadSealedOperatorModel(encKey);
            return m?.standingDirectives ?? [];
          } catch { return []; }
        })(),
        (async () => {
          try { return (await import('../gdrive/dead-ends.js')).listDeadEnds('confirmed').map((d) => `${d.summary} — ${d.cause}`).slice(0, 10); } catch { return []; }
        })(),
        (async () => { try { const rt = await getNlmRuntime(); return (await buildShapeContext(rt)).readOpenQuestions?.() ?? []; } catch { return []; } })(),
      ]);
      succ.buildSuccessorPack({
        identitySummary: 'Identity and values are defined by the signed manifest (read-only). Preserve them; do not rewrite frozen surfaces.',
        standingDirectives: directives,
        openQuestions,
        learnings,
      }, encKey);
    } catch (err) {
      log.warn({ err: String(err) }, 'F64 successor pack not sealed (no enc key?) — gate still holds');
    }
  }

  // Acked → run the identity pulse (needs the injected self-answer + a baseline).
  if (phase === 'acked' && selfAnswer) {
    try {
      const { runProbeSelf } = await import('./probe.js');
      const { identityPulse } = await import('./probe-gates.js');
      const { F63_IDENTITY } = await import('./probe-sets.js');
      const { loadBaseline, ensureBaseline } = await import('./probe-store.js');
      const run = await runProbeSelf(F63_IDENTITY, selfAnswer, { studentRoute: 'sudo/cheap' });
      const baseline = loadBaseline(F63_IDENTITY.id) ?? ensureBaseline(run);
      const pulse = identityPulse(F63_IDENTITY, run, baseline);
      succ.recordSuccessionPulse(pulse.alert);
    } catch (err) {
      log.warn({ err: String(err) }, 'F64 succession pulse failed — gate holds');
    }
  }

  // Ready → resume.
  if ((succ.loadSuccessionState()?.phase ?? phase) === 'ready') succ.tryResumeSuccession();
  return { phase: succ.loadSuccessionState()?.phase ?? 'stable' };
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
