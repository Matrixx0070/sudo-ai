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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { PROJECT_ROOT, WORKSPACE_DIR } from '../shared/paths.js';
import { isProtectedPath } from '../self-build/protected-paths.js';
import { normalizeBrainText, type ToolBrain } from '../brain/brain-text.js';
import { detectPatterns, type DetectedPatterns } from './pattern-detector.js';

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
  /** One-line why. */
  rationale: string;
}

const MAX_TEXT = 4000;

function buildDraftPrompt(patterns: DetectedPatterns, learnings: string): string {
  return [
    'You are SUDO-AI proposing ONE small, safe improvement to your OWN source code.',
    'Given the self-diagnosis below, output a SINGLE concrete patch as strict JSON:',
    '{"path":"<repo-relative .ts file>","oldText":"<exact substring to replace>","newText":"<replacement>","rationale":"<one line>"}',
    'Hard rules:',
    '- oldText MUST be an exact, unique substring of the current file (copy it precisely).',
    '- Keep it tiny and low-risk (a comment, a log message, a guard, a small fix).',
    '- Never touch identity/constitution/protected paths, tests, or config.',
    '- If you are not highly confident the oldText matches verbatim, output {"path":""} to decline.',
    'Output ONLY the JSON object, nothing else.',
    '',
    '## Self-diagnosis',
    `Health: ${patterns.healthScore}/100`,
    patterns.failingTools.length ? `Failing tools: ${patterns.failingTools.map((t) => `${t.name} (${Math.round(t.failRate * 100)}%)`).join(', ')}` : 'No failing tools.',
    patterns.badFeedbackTypes.length ? `Weak task types: ${patterns.badFeedbackTypes.map((b) => `${b.taskType} ${Math.round(b.badRate * 100)}% bad`).join(', ')}` : '',
    '',
    '## Recent learnings',
    learnings.slice(0, 1500),
  ].filter(Boolean).join('\n');
}

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

/** Resolve + guard a patch's target file. Returns absolute path or null. */
function safeTarget(rel: string): string | null {
  const abs = path.resolve(PROJECT_ROOT, rel);
  if (!abs.startsWith(PROJECT_ROOT + path.sep)) return null;
  const relNorm = path.relative(PROJECT_ROOT, abs);
  if (isProtectedPath(relNorm)) return null;
  if (/(^|\/)tests?\//.test(relNorm) || relNorm.startsWith('config/')) return null;
  if (!existsSync(abs)) return null;
  return abs;
}

/** True when oldText occurs EXACTLY ONCE in the file (safe, unambiguous edit). */
function occursOnce(abs: string, oldText: string): boolean {
  const content = readFileSync(abs, 'utf-8');
  const first = content.indexOf(oldText);
  return first >= 0 && content.indexOf(oldText, first + 1) === -1;
}

/**
 * Dry-run a patch: apply in place, `tsc --noEmit`, then ALWAYS restore. Returns
 * whether the project still typechecks. Never leaves the file modified.
 */
export function dryRunTypecheck(abs: string, patch: CodePatch): { ok: boolean; detail: string } {
  const original = readFileSync(abs, 'utf-8');
  if (!original.includes(patch.oldText)) return { ok: false, detail: 'oldText not found' };
  try {
    writeFileSync(abs, original.replace(patch.oldText, patch.newText), 'utf-8');
    try {
      // Fixed argv, no shell — the target file was already validated non-protected.
      execFileSync('npm', ['run', 'lint'], { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 180_000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { ok: true, detail: 'tsc clean' };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      return { ok: false, detail: out.includes('error TS') ? 'tsc errors' : 'lint failed' };
    }
  } finally {
    writeFileSync(abs, original, 'utf-8'); // restore no matter what
  }
}

/**
 * Draft ONE validated code patch, or null when nothing safe/buildable is found.
 * Never throws. The returned patch is guaranteed to exist verbatim, be
 * unambiguous, non-protected, and typecheck-clean when applied.
 */
export async function draftValidatedCodePatch(
  brain: ToolBrain,
  patterns: DetectedPatterns,
  learnings: string,
): Promise<CodePatch | null> {
  let patch: CodePatch | null;
  try {
    const raw = await brain.chat([{ role: 'user', content: buildDraftPrompt(patterns, learnings) }]);
    patch = parseCodePatch(raw);
  } catch (err) {
    log.debug({ err: String(err) }, 'code-patch draft call failed');
    return null;
  }
  if (!patch) return null;

  const abs = safeTarget(patch.path);
  if (!abs) { log.info({ path: patch.path }, 'code-patch declined: unsafe/protected/missing target'); return null; }
  if (!occursOnce(abs, patch.oldText)) { log.info({ path: patch.path }, 'code-patch declined: oldText not a unique match'); return null; }

  const dry = dryRunTypecheck(abs, patch);
  if (!dry.ok) { log.info({ path: patch.path, detail: dry.detail }, 'code-patch declined: dry-run typecheck failed'); return null; }

  log.info({ path: patch.path, rationale: patch.rationale }, 'code-patch drafted + dry-run typecheck clean');
  return patch;
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

/**
 * Derive a scoped vitest target from a source path so the apply-time test gate
 * does not block on the whole suite: src/core/<area>/… → tests/<area>. Returns
 * undefined when there is no obvious scope (caller then runs the full suite).
 */
export function deriveTestTarget(srcPath: string): string | undefined {
  const m = /^src\/core\/([^/]+)\//.exec(srcPath);
  if (!m) return undefined;
  const candidate = `tests/${m[1]}`;
  return existsSync(path.join(PROJECT_ROOT, candidate)) ? candidate : undefined;
}

/**
 * Apply an owner-approved patch through meta.self-modify's full-cycle gate
 * (backup → tsc → build → test → restart). A failure at ANY gate aborts without
 * restarting; the backup remains for rollback. Never throws. `testTarget` scopes
 * the test gate (defaults to the patched file's area to avoid a full-suite block;
 * pass '' explicitly to force the full suite).
 */
export async function applyApprovedCodePatch(patch: CodePatch, testTarget?: string): Promise<ApplyOutcome> {
  try {
    const { selfModifyTool } = await import('../tools/builtin/meta/self-modify.js');
    const ctx = { sessionId: 'tx19-code-apply' } as unknown as import('../tools/types.js').ToolContext;
    const scoped = testTarget !== undefined ? testTarget : deriveTestTarget(patch.path);
    const res = await selfModifyTool.execute(
      { action: 'full-cycle', path: patch.path, oldText: patch.oldText, newText: patch.newText, ...(scoped ? { testTarget: scoped } : {}) },
      ctx,
    );
    log.info({ path: patch.path, ok: res.success }, 'TX19 code patch apply resolved');
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
