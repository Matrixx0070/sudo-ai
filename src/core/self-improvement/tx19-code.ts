/**
 * @file tx19-code.ts
 * @description TX19 CODE self-improvement — the nightly loop's optional ability
 * to draft an ACTUAL source patch, validate it builds, and offer it to the
 * owner as a Deploy card. Applying happens ONLY on the owner's tap, through the
 * same full-cycle gate as meta.self-modify (backup → tsc → build → test →
 * restart), and NEVER unattended.
 *
 * Safety envelope (all must hold):
 *   • DEFAULT OFF — inert unless SUDO_TX19_CODE=1.
 *   • The model proposes ONE small patch as {path, oldText, newText, rationale};
 *     oldText must be an EXACT substring of a non-protected in-repo file.
 *   • Before the owner ever sees it, the patch is DRY-RUN typechecked (applied
 *     in place, `tsc --noEmit`, then restored) — a patch that fails tsc is
 *     discarded, never offered.
 *   • Apply is gated behind the owner's Deploy tap and re-runs the full
 *     tsc+build+test gate; a failure aborts without restart (backup remains).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { PROJECT_ROOT, WORKSPACE_DIR } from '../shared/paths.js';
import { normalizeBrainText, type ToolBrain } from '../brain/brain-text.js';
import { detectPatterns, type DetectedPatterns } from './pattern-detector.js';
import { draftValidatedCodePatch } from './tx19-draft.js';

export { draftValidatedCodePatch };

const log = createLogger('self-improvement:tx19-code');

/** DEFAULT OFF — the nightly drafts code patches only when SUDO_TX19_CODE=1. */
export function codeSelfImproveEnabled(): boolean {
  return process.env['SUDO_TX19_CODE'] === '1';
}

export interface CodePatch {
  /** Repo-relative path. */
  path: string;
  /** Exact substring to replace (must exist verbatim in the file). */
  oldText: string;
  /** Replacement. */
  newText: string;
  /** One-line rationale for the change. */
  rationale: string;
}

const MAX_TEXT = 4000;

/** Parse + structurally validate a model patch. Returns null on any problem. */
export function parseCodePatch(raw: string): CodePatch | null {
  const text = normalizeBrainText(raw);
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let obj: Partial<CodePatch>;
  try { obj = JSON.parse(m[0]) as Partial<CodePatch>; } catch { return null; }
  const { path: p, oldText, newText, rationale } = obj;
  if (typeof p !== 'string' || !p || typeof oldText !== 'string' || typeof newText !== 'string') return null;
  if (!oldText || oldText === newText) return null;
  if (oldText.length > MAX_TEXT || newText.length > MAX_TEXT) return null;
  if (!p.endsWith('.ts') || p.includes('..')) return null;
  return { path: p, oldText, newText, rationale: typeof rationale === 'string' ? rationale : '' };
}

/** Minimal checkpoint seam so this module need not import the telegram stack. */
export interface CheckpointFiler {
  request(req: { kind: string; question: string; options: string[]; context?: Record<string, unknown>; timeoutMs?: number }): Promise<unknown>;
}

/**
 * The nightly CODE step: draft ONE validated patch and file a Deploy card for
 * the owner. Fire-and-forget — the card is persisted + delivered; the owner's
 * later Deploy tap applies it (see the telegram tx10 hook). No-op when disabled
 * or when nothing safe/buildable is found. Never throws.
 */
export async function runCodeSelfImproveCycle(
  brain: ToolBrain,
  filer: CheckpointFiler,
  date: string,
  windowDays = 14,
): Promise<{ drafted: boolean; path?: string }> {
  if (!codeSelfImproveEnabled()) return { drafted: false };
  try {
    let patterns: DetectedPatterns;
    try { patterns = detectPatterns(windowDays); } catch { return { drafted: false }; }
    let learnings = '';
    try { learnings = readFileSync(path.join(WORKSPACE_DIR, 'LEARNINGS.md'), 'utf-8'); } catch { /* optional */ }

    const patch = await draftValidatedCodePatch(brain, patterns, learnings);
    if (!patch) return { drafted: false };

    // Fire-and-forget: persist + deliver the card; do NOT block on the tap.
    void filer.request({
      kind: 'tx19:deploy-code',
      question: renderCodeDeployCard(patch, date),
      options: ['Deploy', 'Skip'],
      context: { patch },
    });
    log.info({ path: patch.path }, 'TX19 code Deploy card filed for owner approval');
    return { drafted: true, path: patch.path };
  } catch (err) {
    log.warn({ err: String(err) }, 'TX19 code self-improve cycle failed (non-fatal)');
    return { drafted: false };
  }
}

export interface ApplyOutcome { ok: boolean; output: string }

/** Max importing-test files to run at apply time (bounds a widely-imported file). */
const MAX_IMPORTER_TESTS = 20;

/**
 * Find test files that IMPORT the patched source module. Tests import it via a
 * relative path (`../../src/core/feedback/store.js`) or the `@core` alias
 * (`@core/feedback/store.js`); both contain the suffix `core/feedback/store.js`,
 * so that substring is the needle. Walks tests/ once (fast). Capped.
 */
function findImportingTests(srcPath: string): string[] {
  const needle = srcPath.replace(/^src\//, '').replace(/\.ts$/, '.js'); // e.g. core/feedback/store.js
  const out: string[] = [];
  const walk = (relDir: string): void => {
    if (out.length >= MAX_IMPORTER_TESTS) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(path.join(PROJECT_ROOT, relDir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_IMPORTER_TESTS) return;
      const rel = path.join(relDir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); }
      else if (e.name.endsWith('.test.ts')) {
        try { if (readFileSync(path.join(PROJECT_ROOT, rel), 'utf-8').includes(needle)) out.push(rel); } catch { /* skip */ }
      }
    }
  };
  walk('tests');
  return out;
}

/**
 * Resolve the apply-time test scope for a patched source file:
 *   1. the file's OWN test (mirrored `tests/<area>/<name>.test.ts` or co-located),
 *   2. else every test that IMPORTS the file (its real coverage, even when named
 *      differently — e.g. store.ts ← feedback-linkage.test.ts),
 *   3. else skip the test step and rely on tsc+build (already gated).
 * Runs exactly the relevant test FILES — never the whole area suite, which was
 * slow and flaky alongside the live bot.
 */
export function resolveApplyTestPlan(srcPath: string): { testTargets?: string[]; skipTests?: boolean } {
  const named: string[] = [];
  if (srcPath.startsWith('src/core/')) {
    named.push(srcPath.replace(/^src\/core\//, 'tests/').replace(/\.ts$/, '.test.ts'));
  }
  named.push(srcPath.replace(/\.ts$/, '.test.ts')); // co-located
  const exact = named.find((c) => existsSync(path.join(PROJECT_ROOT, c)));
  if (exact) return { testTargets: [exact] };

  const importers = findImportingTests(srcPath);
  if (importers.length > 0) return { testTargets: importers };

  return { skipTests: true };
}

/**
 * Apply an owner-approved patch through meta.self-modify's full-cycle gate
 * (backup → tsc → build → [file-specific test | skip] → commit → restart). A
 * failure at ANY gate aborts without restarting; the backup remains. Never
 * throws. An explicit `testTargetOverride` wins ('' forces the full suite);
 * otherwise the scope is resolved per-file (see resolveApplyTestPlan).
 */
export async function applyApprovedCodePatch(patch: CodePatch, testTargetOverride?: string): Promise<ApplyOutcome> {
  try {
    const { selfModifyTool } = await import('../tools/builtin/meta/self-modify.js');
    const ctx = { sessionId: 'tx19-code-apply' } as unknown as import('../tools/types.js').ToolContext;

    let testTargets: string[] = [];
    let skipTests = false;
    if (testTargetOverride !== undefined) {
      testTargets = testTargetOverride ? [testTargetOverride] : []; // '' → full suite
    } else {
      const plan = resolveApplyTestPlan(patch.path);
      if (plan.skipTests) skipTests = true;
      else testTargets = plan.testTargets ?? [];
    }

    const res = await selfModifyTool.execute(
      {
        action: 'full-cycle', path: patch.path, oldText: patch.oldText, newText: patch.newText,
        ...(testTargets.length ? { testTargets } : {}),
        ...(skipTests ? { skipTests: true } : {}),
        // Commit the applied patch authored as SUDO-AI (self-improvement provenance).
        selfCommitMessage: `self-improve: ${patch.rationale || `patch ${patch.path}`}`,
      },
      ctx,
    );
    log.info({ path: patch.path, testTargets: testTargets.length ? testTargets : (skipTests ? '(tsc+build only)' : '(full)'), ok: res.success }, 'TX19 code patch apply resolved');
    return { ok: res.success, output: res.output };
  } catch (err) {
    return { ok: false, output: `apply crashed: ${String(err)}` };
  }
}

/** Render the Deploy-card body for a validated patch. */
export function renderCodeDeployCard(patch: CodePatch, date: string): string {
  const preview = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);
  return [
    `🌙🔧 Overnight CODE self-improvement — ${date}`,
    `File: ${patch.path}`,
    `Why: ${patch.rationale || '(none given)'}`,
    'Status: dry-run typecheck ✓ (applies via full-cycle: tsc + build + test + restart)',
    '',
    `- ${preview(patch.oldText)}`,
    `+ ${preview(patch.newText)}`,
    '',
    'Deploy = apply now (gated: aborts if build/test fail). Skip = discard.',
  ].join('\n');
}
