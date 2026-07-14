/**
 * textproc.replace — safe find-and-replace with dry-run diff preview,
 * timestamped backups, and binary refusal (Spec 10 §5.3).
 *
 * dryRun DEFAULTS TO TRUE: the first call always returns a unified diff of
 * what WOULD change; the caller re-invokes with dryRun:false to apply.
 * Apply writes `<file>.bak.<epoch>` first, so every change has a same-dir
 * rollback: `mv file.bak.<epoch> file` restores byte-identical content.
 *
 * Replacement runs IN-PROCESS (string split/join, or RegExp for regex:true)
 * rather than shelling to sd/perl: no quoting surface, no injection surface,
 * and a deliberate size cap (50 MB/file) keeps memory bounded — huge-file
 * streaming edits belong to system.exec with sd/sed, which the capability
 * manifest advertises.
 */

import {
  readFileSync, writeFileSync, copyFileSync, statSync, existsSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../../types.js';
import { clampHeadTail } from '../../../shared/head-tail-buffer.js';
import { runArgv, runBashTemplate } from './proc.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_FIND_LEN = 2_000;
const MAX_DIFF_CHARS = 8_000;

function fail(message: string): ToolResult {
  return { success: false, output: message };
}

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8_192);
  return probe.includes(0);
}

async function expandGlob(pattern: string, ctx: ToolContext): Promise<string[]> {
  const abs = isAbsolute(pattern) ? pattern : resolve(ctx.workingDir, pattern);
  if (!/[*?[]/.test(abs)) return existsSync(abs) ? [abs] : [];
  // compgen -G expands the pattern WITHOUT executing anything; the pattern
  // travels as a positional parameter, never re-parsed as shell syntax.
  // No `--` here: compgen -G treats it as the pattern itself. The pattern is
  // always absolute by this point (resolved above), so it can't read as a flag.
  const r = await runBashTemplate('compgen -G "$1" || true', [abs], { maxBytes: 256 * 1024 });
  return r.stdout.split('\n').filter(Boolean);
}

export const replaceTool: ToolDefinition = {
  name: 'textproc.replace',
  description:
    'Safe find-and-replace across one file or a glob. ALWAYS previews first: dryRun defaults to ' +
    'true and returns a unified diff of what would change — call again with dryRun:false to apply. ' +
    'Apply creates a same-directory backup (<file>.bak.<epoch>) per changed file for rollback. ' +
    'regex:true treats find as a JavaScript regular expression (flags gm). Refuses binary files ' +
    'and files over 50 MB (use system.exec with sd/sed for streaming edits of huge files).',
  category: 'textproc',
  parameters: {
    file: { type: 'string', description: 'File path or glob (e.g. "src/**" is NOT supported — single-level globs like "src/*.ts").', required: true },
    find: { type: 'string', description: 'Literal text to find, or a JS regex source when regex:true.', required: true },
    replace: { type: 'string', description: 'Replacement text ($1… backrefs allowed when regex:true).', required: true },
    regex: { type: 'boolean', description: 'Interpret find as a regular expression (flags gm).', default: false },
    dryRun: { type: 'boolean', description: 'Preview only (DEFAULT true). Set false to apply.', default: true },
    backup: { type: 'boolean', description: 'Write <file>.bak.<epoch> before modifying (default true).', default: true },
  },
  safety: 'destructive',
  timeout: 60_000,
  async execute(params, ctx): Promise<ToolResult> {
    const find = String(params['find'] ?? '');
    const replacement = String(params['replace'] ?? '');
    if (!find) return fail('textproc.replace: find must be non-empty');
    if (find.length > MAX_FIND_LEN) return fail(`textproc.replace: find too long (>${MAX_FIND_LEN} chars)`);
    const useRegex = params['regex'] === true;
    const dryRun = params['dryRun'] !== false; // DEFAULT TRUE — only explicit false applies
    const doBackup = params['backup'] !== false;

    let re: RegExp | null = null;
    if (useRegex) {
      try {
        re = new RegExp(find, 'gm');
      } catch (e) {
        return fail(`textproc.replace: invalid regex: ${String(e)}`);
      }
    }

    const files = await expandGlob(String(params['file'] ?? ''), ctx);
    if (files.length === 0) return fail(`textproc.replace: no files match ${String(params['file'])}`);
    if (files.length > MAX_FILES) {
      return fail(`textproc.replace: ${files.length} files match — cap is ${MAX_FILES}; narrow the glob`);
    }

    const diffs: string[] = [];
    const artifacts: ToolArtifact[] = [];
    const skipped: string[] = [];
    let changedFiles = 0;
    let totalReplacements = 0;

    for (const f of files) {
      let st;
      try {
        st = statSync(f);
      } catch {
        skipped.push(`${f} (unreadable)`);
        continue;
      }
      if (!st.isFile()) { skipped.push(`${f} (not a regular file)`); continue; }
      if (st.size > MAX_FILE_BYTES) { skipped.push(`${f} (>50 MB — use system.exec/sd)`); continue; }
      const buf = readFileSync(f);
      if (looksBinary(buf)) { skipped.push(`${f} (binary — refused)`); continue; }
      const original = buf.toString('utf-8');

      let updated: string;
      let count = 0;
      if (re) {
        updated = original.replace(re, (...m) => {
          count += 1;
          // Reuse JS's own $-substitution by delegating to String.replace semantics:
          return replacement.replace(/\$(\d+|\$|&)/g, (_s, g: string) => {
            if (g === '$') return '$';
            if (g === '&') return String(m[0]);
            const idx = parseInt(g, 10);
            const group = m[idx];
            return typeof group === 'string' ? group : '';
          });
        });
      } else {
        const parts = original.split(find);
        count = parts.length - 1;
        updated = parts.join(replacement);
      }
      if (count === 0) continue;

      changedFiles += 1;
      totalReplacements += count;
      const diff = await runArgv(
        'diff',
        ['-u', '--label', `a/${f}`, '--label', `b/${f}`, f, '-'],
        { stdinText: updated, maxBytes: 512 * 1024 },
      );
      diffs.push(diff.stdout || `(diff unavailable, ${count} replacement(s) in ${f})`);

      if (!dryRun) {
        if (doBackup) {
          const bak = `${f}.bak.${Date.now()}`;
          copyFileSync(f, bak);
          artifacts.push({ path: bak, action: 'created', size: st.size });
        }
        writeFileSync(f, updated);
        artifacts.push({ path: f, action: 'modified', size: Buffer.byteLength(updated) });
      }
    }

    if (changedFiles === 0) {
      const note = skipped.length ? ` Skipped: ${skipped.join('; ')}` : '';
      return { success: true, output: `textproc.replace: 0 matches in ${files.length} file(s) — nothing to do.${note}` };
    }

    const { text: diffText } = clampHeadTail(diffs.join('\n'), {
      headBudget: MAX_DIFF_CHARS / 2,
      tailBudget: MAX_DIFF_CHARS / 2,
      elisionMarker: '...[diff truncated — {n} chars elided]...',
    });
    const header = dryRun
      ? `DRY RUN — ${totalReplacements} replacement(s) across ${changedFiles} file(s). Re-run with dryRun:false to apply.`
      : `APPLIED ${totalReplacements} replacement(s) across ${changedFiles} file(s).${doBackup ? ' Backups: <file>.bak.<epoch> (mv back to roll back).' : ' (backup:false — no rollback files)'}`;
    const skipNote = skipped.length ? `\nSkipped: ${skipped.join('; ')}` : '';
    return {
      success: true,
      output: `${header}\n\n${diffText}${skipNote}`,
      data: { dryRun, changedFiles, totalReplacements, skipped },
      artifacts,
    };
  },
};
