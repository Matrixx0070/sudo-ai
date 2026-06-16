/**
 * @file patch-applier.ts
 * @description Apply a list of {@link PatchOp} against the project tree.
 *
 * Design principles:
 *   - **Atomic per file**: each file's mutations are accumulated in memory,
 *     then written to a sibling `<file>.arsenal-tmp`, fsync'd, and renamed
 *     onto the target. A crash mid-write leaves the original intact.
 *   - **Drift-detected**: every `str_replace` / `insert_*` op verifies the
 *     anchor exists exactly once in the CURRENT file content. If the file
 *     has been modified since the LLM read it (so `old` / `anchor` no longer
 *     matches), the op is skipped with reason `drift_detected` — the LLM's
 *     plan was made against stale state.
 *   - **Per-file isolation**: one file failing doesn't abort the others.
 *     The caller gets a per-op result list and can decide what to retry.
 *   - **Backed up**: every file we touch is copied to a timestamped backup
 *     dir before the rename, so a rollback is a `cp -r` away.
 *
 * Out of scope for this slice:
 *   - Auto-rebase on drift (skip-and-surface instead).
 *   - tsc / test verification (separate module).
 *   - Concurrent locking (single-threaded by design).
 */

import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import path from 'node:path';
import type {
  ApplyResult,
  PatchOp,
  PatchOpResult,
} from './patch-types.js';

export interface ApplyOptions {
  /** Project root — used to resolve relative `file` paths and bound writes. */
  projectRoot: string;
  /**
   * Directory where backups are written. The applier creates a timestamped
   * subdirectory under this (e.g. `<backupRoot>/1718500000000/`).
   */
  backupRoot: string;
}

/**
 * Public entry point. Groups ops by file, applies each group atomically,
 * collects per-op results.
 */
export function applyPatches(ops: PatchOp[], opts: ApplyOptions): ApplyResult {
  const backupDir = path.join(opts.backupRoot, String(Date.now()));
  mkdirSync(backupDir, { recursive: true });

  const byFile = groupByFile(ops);
  const results: PatchOpResult[] = [];
  const filesWritten: string[] = [];
  const filesDeleted: string[] = [];

  for (const [relFile, fileOps] of byFile.entries()) {
    const fileResults = applyToFile(relFile, fileOps, opts, backupDir);
    for (const r of fileResults) results.push(r);

    // Surface aggregated outcome to the caller's filesWritten / filesDeleted
    // lists when at least one op in the group succeeded.
    const someApplied = fileResults.some((r) => r.status === 'applied');
    if (!someApplied) continue;
    const sawDelete = fileOps.some((op) => op.op === 'delete_file');
    if (sawDelete) filesDeleted.push(relFile);
    else filesWritten.push(relFile);
  }

  return { results, filesWritten, filesDeleted, backupDir };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertPathWithinRoot(absPath: string, projectRoot: string): boolean {
  try {
    if (existsSync(absPath)) {
      const real = realpathSync(absPath);
      const rel = path.relative(projectRoot, real);
      return !rel.startsWith('..');
    }
    const dir = path.dirname(absPath);
    if (existsSync(dir)) {
      const realDir = realpathSync(dir);
      const rel = path.relative(projectRoot, realDir);
      return !rel.startsWith('..');
    }
    const rel = path.relative(projectRoot, absPath);
    return !rel.startsWith('..');
  } catch {
    return false;
  }
}

function groupByFile(ops: PatchOp[]): Map<string, PatchOp[]> {
  const map = new Map<string, PatchOp[]>();
  for (const op of ops) {
    const list = map.get(op.file);
    if (list) list.push(op);
    else map.set(op.file, [op]);
  }
  return map;
}

function applyToFile(
  relFile: string,
  ops: PatchOp[],
  opts: ApplyOptions,
  backupDir: string,
): PatchOpResult[] {
  const absFile = path.resolve(opts.projectRoot, relFile);

  // Path-traversal guard: includes symlink resolution to detect symlink attacks
  if (!assertPathWithinRoot(absFile, opts.projectRoot)) {
    return ops.map<PatchOpResult>((op) => ({
      op,
      status: 'failed',
      reason: 'path_outside_project',
      detail: `${relFile} resolves outside the project root`,
    }));
  }

  // Detect the file-level operation kind. Mixing create/delete with text
  // mutations against the same file in one batch is rejected — the call
  // shape is ambiguous and the LLM should split it.
  const hasCreate = ops.some((op) => op.op === 'create_file');
  const hasDelete = ops.some((op) => op.op === 'delete_file');
  const hasMutate = ops.some(
    (op) => op.op === 'str_replace' || op.op === 'insert_after' || op.op === 'insert_before',
  );
  if ([hasCreate, hasDelete, hasMutate].filter(Boolean).length > 1) {
    return ops.map<PatchOpResult>((op) => ({
      op,
      status: 'failed',
      reason: 'io_error',
      detail: `${relFile}: mixed create/delete/mutate ops in one batch — split into separate runs`,
    }));
  }

  if (hasCreate) return applyCreate(absFile, relFile, ops, backupDir, opts.projectRoot);
  if (hasDelete) return applyDelete(absFile, relFile, ops, backupDir);
  return applyMutations(absFile, relFile, ops, backupDir, opts.projectRoot);
}

function applyCreate(
  absFile: string,
  relFile: string,
  ops: PatchOp[],
  backupDir: string,
  projectRoot: string,
): PatchOpResult[] {
  // Only one create_file per file is meaningful; if more were submitted the
  // group above already passed them as a batch — apply the first, mark rest
  // as skipped no-ops.
  const first = ops.find((op): op is Extract<PatchOp, { op: 'create_file' }> => op.op === 'create_file')!;
  if (existsSync(absFile)) {
    return ops.map((op) => ({
      op,
      status: 'failed' as const,
      reason: 'file_already_exists' as const,
      detail: `${relFile} already exists`,
    }));
  }
  try {
    mkdirSync(path.dirname(absFile), { recursive: true });
    atomicWrite(absFile, first.content, projectRoot);
    // No prior content to back up — drop a marker so the backup dir reflects
    // every touched file consistently.
    writeFileSync(path.join(backupDir, encodePath(relFile) + '.created'), '');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return ops.map((op) => ({ op, status: 'failed' as const, reason: 'io_error' as const, detail }));
  }
  return ops.map<PatchOpResult>((op, idx) =>
    idx === ops.indexOf(first)
      ? { op, status: 'applied' }
      : { op, status: 'skipped', reason: 'io_error', detail: 'duplicate create_file in batch — only the first was applied' },
  );
}

function applyDelete(
  absFile: string,
  relFile: string,
  ops: PatchOp[],
  backupDir: string,
): PatchOpResult[] {
  if (!existsSync(absFile)) {
    return ops.map((op) => ({
      op,
      status: 'failed' as const,
      reason: 'file_not_found' as const,
      detail: `${relFile} does not exist`,
    }));
  }
  try {
    const backupPath = path.join(backupDir, encodePath(relFile));
    copyFileSync(absFile, backupPath);
    unlinkSync(absFile);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return ops.map((op) => ({ op, status: 'failed' as const, reason: 'io_error' as const, detail }));
  }
  // The first op is the canonical applied one; any duplicate delete_file in
  // the batch is reported as skipped (file already gone).
  let first = true;
  return ops.map<PatchOpResult>((op) => {
    if (first) { first = false; return { op, status: 'applied' }; }
    return { op, status: 'skipped', reason: 'file_not_found', detail: 'file was deleted by an earlier op in this batch' };
  });
}

function applyMutations(
  absFile: string,
  relFile: string,
  ops: PatchOp[],
  backupDir: string,
  projectRoot: string,
): PatchOpResult[] {
  if (!existsSync(absFile)) {
    return ops.map((op) => ({
      op,
      status: 'failed' as const,
      reason: 'file_not_found' as const,
      detail: `${relFile} does not exist`,
    }));
  }

  let current: string;
  try {
    current = readFileSync(absFile, 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return ops.map((op) => ({ op, status: 'failed' as const, reason: 'io_error' as const, detail }));
  }

  // Walk each op in declaration order, mutating `current` in memory. A failed
  // op is reported and the remaining ops continue against the latest state —
  // drift compounds, so a later op failing is informative for the LLM.
  const results: PatchOpResult[] = [];
  let anyApplied = false;
  for (const op of ops) {
    const result = applyOneMutation(op, current);
    results.push(result.result);
    if (result.result.status === 'applied') {
      current = result.next;
      anyApplied = true;
    }
  }

  if (!anyApplied) return results;

  try {
    const backupPath = path.join(backupDir, encodePath(relFile));
    copyFileSync(absFile, backupPath);
    atomicWrite(absFile, current, projectRoot);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // I/O failure at the rename layer — mark every previously-applied op as
    // failed so the caller knows nothing landed on disk.
    return results.map((r) =>
      r.status === 'applied' ? { ...r, status: 'failed' as const, reason: 'io_error' as const, detail } : r,
    );
  }

  return results;
}

function applyOneMutation(op: PatchOp, current: string): { result: PatchOpResult; next: string } {
  if (op.op === 'str_replace') {
    const first = current.indexOf(op.old);
    if (first === -1) {
      return { result: { op, status: 'skipped', reason: 'drift_detected', detail: `"old" not found in current file` }, next: current };
    }
    const second = current.indexOf(op.old, first + op.old.length);
    if (second !== -1) {
      return { result: { op, status: 'skipped', reason: 'anchor_ambiguous', detail: `"old" matched ${countOccurrences(current, op.old)} times — make it unique with more surrounding context` }, next: current };
    }
    const next = current.slice(0, first) + op.new + current.slice(first + op.old.length);
    return { result: { op, status: 'applied' }, next };
  }

  if (op.op === 'insert_after' || op.op === 'insert_before') {
    const anchorIdx = current.indexOf(op.anchor);
    if (anchorIdx === -1) {
      return { result: { op, status: 'skipped', reason: 'anchor_not_found', detail: `anchor not found in current file` }, next: current };
    }
    const second = current.indexOf(op.anchor, anchorIdx + op.anchor.length);
    if (second !== -1) {
      return { result: { op, status: 'skipped', reason: 'anchor_ambiguous', detail: `anchor matched ${countOccurrences(current, op.anchor)} times` }, next: current };
    }
    if (op.op === 'insert_after') {
      // Insert after the anchor line: find the next newline and inject before
      // it; if no trailing newline, append.
      const nlIdx = current.indexOf('\n', anchorIdx);
      if (nlIdx === -1) {
        const next = current + '\n' + op.content;
        return { result: { op, status: 'applied' }, next };
      }
      const next = current.slice(0, nlIdx + 1) + op.content + (op.content.endsWith('\n') ? '' : '\n') + current.slice(nlIdx + 1);
      return { result: { op, status: 'applied' }, next };
    }
    // insert_before: find the start of the anchor's line and inject before it.
    const lineStart = current.lastIndexOf('\n', anchorIdx) + 1;
    const next = current.slice(0, lineStart) + op.content + (op.content.endsWith('\n') ? '' : '\n') + current.slice(lineStart);
    return { result: { op, status: 'applied' }, next };
  }

  // create_file / delete_file shouldn't reach here — they're handled earlier.
  return { result: { op, status: 'failed', reason: 'io_error', detail: 'mutate-path received non-mutate op' }, next: current };
}

/** Atomic write: temp -> fsync -> rename (with EXDEV fallback and TOCTOU validation). */
function atomicWrite(absFile: string, content: string, projectRoot: string): void {
  const tmp = absFile + '.arsenal-tmp';
  writeFileSync(tmp, content, 'utf-8');
  // fsync to ensure durability before rename
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(tmp, absFile);
  } catch (renameErr: unknown) {
    const e = renameErr as { code?: string; message?: string };
    if (e.code === 'EXDEV') {
      // Cross-filesystem: fall back to copy + delete
      copyFileSync(tmp, absFile);
      unlinkSync(tmp);
    } else {
      throw renameErr;
    }
  }
  // TOCTOU validation: after write, verify target is still within project root.
  // Resolve projectRoot too so a symlinked tmpdir (e.g. macOS /var → /private/var)
  // doesn't trip a false positive.
  if (existsSync(absFile)) {
    try {
      const realRoot = realpathSync(projectRoot);
      const realAbs = realpathSync(absFile);
      const rel = path.relative(realRoot, realAbs);
      if (rel.startsWith('..')) {
        throw new Error('TOCTOU: file was moved outside project root after write');
      }
    } catch (validateErr) {
      if (validateErr instanceof Error && validateErr.message.includes('TOCTOU')) {
        throw validateErr;
      }
      // If realpathSync fails, file may have been deleted post-write — log but continue
    }
  }
}

/**
 * Escape a project-relative path so it's safe as a filename in the backup
 * directory. Path separators become double-underscores; everything else is
 * preserved verbatim so the backup name is recognizable by humans.
 *
 * Exported so revert.ts can decode without duplicating the rule — keeps the
 * write + read sides of the backup contract pinned to a single source.
 */
export function encodePath(relFile: string): string {
  return relFile.replace(/[\\/]/g, '__');
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}
