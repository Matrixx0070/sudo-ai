/**
 * @file tx19-draft.ts
 * @description The DRAFTER for TX19 code self-improvement — kept separate from
 * the card/apply plumbing in tx19-code.ts.
 *
 * Yield fix: the old single-shot prompt asked the model to RECALL an exact
 * source substring, so `oldText` almost never matched and every draft was
 * discarded. This drafter is TWO-STAGE and content-grounded:
 *   1. PICK  — the model chooses ONE target file from a real candidate list
 *              (guaranteed to exist + be non-protected).
 *   2. PATCH — the model is shown that file's ACTUAL contents and must copy
 *              `oldText` verbatim from what it was shown.
 * The same guards still apply after: unique match, non-protected, and a dry-run
 * `tsc --noEmit` that is discarded — nothing broken can survive to a card.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { PROJECT_ROOT } from '../shared/paths.js';
import { isProtectedPath } from '../self-build/protected-paths.js';
import { normalizeBrainText, type ToolBrain } from '../brain/brain-text.js';
import type { DetectedPatterns } from './pattern-detector.js';
import type { CodePatch } from './tx19-code.js';

const log = createLogger('self-improvement:tx19-draft');

const MAX_TEXT = 4000;
const MAX_CONTENT_BYTES = 20_000;
const MAX_CANDIDATES = 150;

/** Resolve + guard a candidate path. Returns absolute path or null. */
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

/** Recursively collect safe, non-protected src/core/*.ts candidate paths (minus excludes). */
function listSafeCandidates(max = MAX_CANDIDATES, exclude?: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= max) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(full); }
      else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
        const rel = path.relative(PROJECT_ROOT, full);
        if (!exclude?.has(rel) && safeTarget(rel)) out.push(rel);
      }
    }
  };
  walk(path.join(PROJECT_ROOT, 'src', 'core'));
  return out;
}

function buildPickPrompt(patterns: DetectedPatterns, learnings: string, candidates: string[]): string {
  return [
    'You are SUDO-AI choosing ONE of your OWN source files to improve tonight.',
    'Pick a file where a small, safe change (a clearer comment, a better log',
    'message, a tightened guard) would genuinely help. Reply with ONLY the exact',
    'repo-relative path from the list — nothing else.',
    '',
    `Health: ${patterns.healthScore}/100`,
    patterns.failingTools.length ? `Failing tools: ${patterns.failingTools.map((t) => t.name).join(', ')}` : '',
    learnings ? `Recent learnings (excerpt): ${learnings.slice(0, 600)}` : '',
    '',
    'Candidate files:',
    ...candidates.map((c) => `- ${c}`),
  ].filter(Boolean).join('\n');
}

/** Return the first candidate path that appears in the model reply, else null. */
export function parsePick(raw: string, candidates: string[]): string | null {
  const text = normalizeBrainText(raw);
  // Prefer the longest match so a nested path is not shadowed by a prefix.
  const hits = candidates.filter((c) => text.includes(c)).sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
}

/** Cap the file content fed to the model (head slice for very large files). */
export function boundContent(content: string): string {
  if (content.length <= MAX_CONTENT_BYTES) return content;
  return content.slice(0, MAX_CONTENT_BYTES) + '\n/* …file truncated for prompt; only edit text shown above */';
}

function buildPatchPrompt(relPath: string, content: string): string {
  return [
    `Below is the FULL current content of ${relPath}.`,
    'Propose ONE tiny, safe improvement as strict JSON:',
    '{"oldText":"<exact substring copied from the content below>","newText":"<replacement>","rationale":"<one line>"}',
    'Rules:',
    '- oldText MUST be copied CHARACTER-FOR-CHARACTER from the content below and occur exactly once.',
    '- Keep it tiny and behaviour-preserving (comment/log/wording/guard).',
    '- newText must keep the file typecheck-clean.',
    '- If nothing is worth changing, reply {"oldText":""} to decline.',
    'Output ONLY the JSON object.',
    '',
    '----- FILE CONTENT -----',
    content,
  ].join('\n');
}

/** Parse the stage-2 patch body {oldText,newText,rationale}. Null on any problem. */
export function parsePatchBody(raw: string): { oldText: string; newText: string; rationale: string } | null {
  const text = normalizeBrainText(raw);
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let obj: { oldText?: unknown; newText?: unknown; rationale?: unknown };
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const { oldText, newText, rationale } = obj;
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
  if (!oldText || oldText === newText) return null;
  if (oldText.length > MAX_TEXT || newText.length > MAX_TEXT) return null;
  return { oldText, newText, rationale: typeof rationale === 'string' ? rationale : '' };
}

/**
 * Draft ONE validated code patch (two-stage, content-grounded), or null when
 * nothing safe/buildable is found. Never throws. A returned patch is guaranteed
 * to exist verbatim, be unique, non-protected, and typecheck-clean when applied.
 */
export async function draftValidatedCodePatch(
  brain: ToolBrain,
  patterns: DetectedPatterns,
  learnings: string,
  excludePaths?: Set<string>,
): Promise<CodePatch | null> {
  const candidates = listSafeCandidates(MAX_CANDIDATES, excludePaths);
  if (candidates.length === 0) return null;

  // Stage 1 — pick a real target file.
  let relPath: string | null;
  try {
    relPath = parsePick(await brain.chat([{ role: 'user', content: buildPickPrompt(patterns, learnings, candidates) }]), candidates);
  } catch (err) { log.debug({ err: String(err) }, 'pick call failed'); return null; }
  if (!relPath) { log.info('code-patch declined: model picked no candidate file'); return null; }
  const abs = safeTarget(relPath);
  if (!abs) return null;

  // Stage 2 — patch grounded in the file's ACTUAL contents.
  let body: { oldText: string; newText: string; rationale: string } | null;
  try {
    const content = boundContent(readFileSync(abs, 'utf-8'));
    body = parsePatchBody(await brain.chat([{ role: 'user', content: buildPatchPrompt(relPath, content) }]));
  } catch (err) { log.debug({ err: String(err) }, 'patch call failed'); return null; }
  if (!body) { log.info({ path: relPath }, 'code-patch declined: no usable patch body'); return null; }

  const patch: CodePatch = { path: relPath, oldText: body.oldText, newText: body.newText, rationale: body.rationale };
  if (!occursOnce(abs, patch.oldText)) { log.info({ path: relPath }, 'code-patch declined: oldText not a unique match'); return null; }
  const dry = dryRunTypecheck(abs, patch);
  if (!dry.ok) { log.info({ path: relPath, detail: dry.detail }, 'code-patch declined: dry-run typecheck failed'); return null; }

  log.info({ path: relPath, rationale: patch.rationale }, 'code-patch drafted (content-grounded) + dry-run clean');
  return patch;
}
