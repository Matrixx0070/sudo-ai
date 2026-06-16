/**
 * @file patch-types.ts
 * @description Patch op shapes for arsenal-v2.
 *
 * arsenal-v2 replaces v1's full-file rewrite with surgical patch operations.
 * The LLM outputs a JSON array of PatchOp; the applier executes them with
 * SHA-based drift detection so a stale file is detected and skipped rather
 * than corrupted by an outdated rewrite.
 *
 * Op semantics:
 *   str_replace   — find a unique occurrence of `old` in the file, replace
 *                   it with `new`. Fails if `old` appears 0 or >1 times.
 *   insert_after  — find a unique occurrence of `anchor` (single line), insert
 *                   `content` on the line immediately after it.
 *   insert_before — same as insert_after but inserts on the preceding line.
 *   create_file   — write `content` to a new file. Fails if the file exists.
 *   delete_file   — delete an existing file. Fails if the file doesn't exist.
 *
 * Path semantics: `file` is relative to the project root and must resolve
 * inside the project tree (path-traversal blocked at the applier layer).
 */

export interface StrReplaceOp {
  op: 'str_replace';
  /** Project-relative file path. */
  file: string;
  /** Exact string to find — must occur exactly once in the file. */
  old: string;
  /** Replacement string (the complete new content for the matched region). */
  new: string;
}

export interface InsertAfterOp {
  op: 'insert_after';
  file: string;
  /** Exact single-line match in the file (must occur exactly once). */
  anchor: string;
  /** Content to insert on the line(s) immediately after the anchor. */
  content: string;
}

export interface InsertBeforeOp {
  op: 'insert_before';
  file: string;
  anchor: string;
  content: string;
}

export interface CreateFileOp {
  op: 'create_file';
  file: string;
  /** Full content of the new file. */
  content: string;
}

export interface DeleteFileOp {
  op: 'delete_file';
  file: string;
}

/** Discriminated union of every supported patch op. */
export type PatchOp =
  | StrReplaceOp
  | InsertAfterOp
  | InsertBeforeOp
  | CreateFileOp
  | DeleteFileOp;

/** Per-op outcome reported by the applier. */
export interface PatchOpResult {
  op: PatchOp;
  status: 'applied' | 'skipped' | 'failed';
  /** Populated when status is 'skipped' or 'failed'. */
  reason?:
    | 'drift_detected'
    | 'anchor_not_found'
    | 'anchor_ambiguous'
    | 'file_not_found'
    | 'file_already_exists'
    | 'path_outside_project'
    | 'io_error';
  /** Free-form detail for the user (file size, similar matches, error message). */
  detail?: string;
}

/** Aggregate apply outcome across multiple ops. */
export interface ApplyResult {
  results: PatchOpResult[];
  /** Files that were actually written (post-rename). Relative paths. */
  filesWritten: string[];
  /** Files that were deleted. Relative paths. */
  filesDeleted: string[];
  /** Backup directory (timestamped) where pre-state copies live. */
  backupDir: string;
}
