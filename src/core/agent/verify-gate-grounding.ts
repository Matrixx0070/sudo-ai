/**
 * @file verify-gate-grounding.ts
 * @description In-loop verification gate — slice 2: grounding check.
 *
 * Slice 1 (`ConfidenceGate` in verify-gate.ts) emits an `escalate` decision
 * for destructive tool calls whose live audit-derived confidence falls below
 * threshold. This module consumes that signal and runs a cheap, fail-open
 * grounding pass before the tool actually executes:
 *
 *   1. **edit-grounding** — args carry a `file_path` + `old_string` pair
 *      (the universal Edit-class shape). Read the target file; if it does
 *      not contain `old_string` byte-for-byte the call is ungrounded.
 *
 *   2. **file-reference-grounding** — args carry a single file/path field
 *      that the tool is expected to *consume* (e.g. `meta.run-workflow.file`,
 *      `meta.memory-consolidate.memoryPath`). The target must stat as a
 *      regular file.
 *
 * Slice 2 is **observable-only by default**. Mismatches are logged + emitted
 * as `verify_gate_grounding_failed`, but execution proceeds. Opt-in
 * `SUDO_VERIFY_GATE_BLOCK=1` upgrades a mismatch to a hard block (the
 * tool-call returns a structured error result, same shape as the existing
 * security / permission blocks in `executeSingleToolCall`).
 *
 * Symbol-claim grounding (graphify lookup) is deferred: no destructive tool
 * in the current registry takes a bare symbol name. Adding a no-op now would
 * violate the "don't design for hypothetical future requirements" rule. When
 * a symbol-claim destructive tool lands, extend `pickGroundingCheck` here.
 */

import { promises as fs } from 'node:fs';
import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:verify-gate-grounding');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GroundingResult {
  /** True when the agent's implicit claim matches reality (or there's no check). */
  ok: boolean;
  /**
   * One of:
   *   - 'no-check'             — no grounding check applies to this tool call
   *   - 'edit-grounding-ok'    — old_string found in current file content
   *   - 'edit-grounding-fail'  — old_string NOT found in current file content
   *   - 'file-missing'         — referenced file does not exist
   *   - 'file-ref-ok'          — referenced file exists as regular file
   *   - 'file-ref-not-regular' — path exists but is not a regular file
   *   - 'error'                — check threw; failing open
   */
  reason: string;
  /** Which check class fired, for telemetry. */
  checked?: 'edit-grounding' | 'file-reference-grounding';
  /** Small structured evidence payload for hooks + logs (no file contents). */
  evidence?: Record<string, unknown>;
}

export interface GroundingCheckerOptions {
  /** Override `fs.readFile` for tests. */
  readFile?: (p: string) => Promise<string>;
  /** Override `fs.stat` for tests. Returns minimal `isFile()` shape. */
  stat?: (p: string) => Promise<{ isFile(): boolean }>;
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

/**
 * Returns true when `SUDO_VERIFY_GATE_BLOCK=1`. Default OFF: grounding
 * mismatches log + emit a hook event but do not block execution.
 */
export function isGroundingBlockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_VERIFY_GATE_BLOCK'] === '1';
}

// ---------------------------------------------------------------------------
// GroundingChecker
// ---------------------------------------------------------------------------

/**
 * GroundingChecker — slice 2.
 *
 * Stateless aside from injectable fs handles. Each `check(toolName, args)`
 * call does at most one fs.readFile or fs.stat. Every error path returns
 * `ok: true` with `reason: 'error'` so a flaky disk never bricks the loop.
 */
export class GroundingChecker {
  private readonly readFile: (p: string) => Promise<string>;
  private readonly stat: (p: string) => Promise<{ isFile(): boolean }>;

  constructor(opts: GroundingCheckerOptions = {}) {
    this.readFile = opts.readFile ?? ((p) => fs.readFile(p, 'utf8'));
    this.stat = opts.stat ?? ((p) => fs.stat(p));
  }

  // toolName is reserved for per-tool dispatch in a future slice (e.g. skip
  // file-reference grounding for shell tools). Slice 2 routes purely on
  // arg-shape heuristics; the parameter is accepted now so the public
  // signature does not need to change later.
  async check(toolName: string, args: Record<string, unknown>): Promise<GroundingResult> {
    try {
      const filePath = pickFilePath(args);
      const oldString = pickOldString(args);

      // Edit-grounding wins when both signals are present.
      if (filePath !== null && oldString !== null) {
        return await this.editGrounding(filePath, oldString);
      }

      // File-reference grounding: tool consumes a file/path that must exist.
      // Skip when args also carry write-content fields (those create files).
      if (filePath !== null && !hasWriteContent(args)) {
        return await this.fileReferenceGrounding(filePath);
      }

      return { ok: true, reason: 'no-check' };
    } catch (err) {
      log.warn({ tool: toolName, err: String(err) }, 'grounding check threw — failing open');
      return { ok: true, reason: 'error' };
    }
  }

  private async editGrounding(filePath: string, oldString: string): Promise<GroundingResult> {
    try {
      const content = await this.readFile(filePath);
      if (content.includes(oldString)) {
        return {
          ok: true,
          reason: 'edit-grounding-ok',
          checked: 'edit-grounding',
          evidence: { filePath, oldStringLen: oldString.length },
        };
      }
      return {
        ok: false,
        reason: 'edit-grounding-fail',
        checked: 'edit-grounding',
        evidence: { filePath, oldStringLen: oldString.length },
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        return {
          ok: false,
          reason: 'file-missing',
          checked: 'edit-grounding',
          evidence: { filePath },
        };
      }
      // Permission errors etc. — fail open to avoid bricking on transient fs issues.
      return { ok: true, reason: 'error', evidence: { filePath, errCode: code ?? null } };
    }
  }

  private async fileReferenceGrounding(filePath: string): Promise<GroundingResult> {
    try {
      const st = await this.stat(filePath);
      if (st.isFile()) {
        return {
          ok: true,
          reason: 'file-ref-ok',
          checked: 'file-reference-grounding',
          evidence: { filePath },
        };
      }
      return {
        ok: false,
        reason: 'file-ref-not-regular',
        checked: 'file-reference-grounding',
        evidence: { filePath },
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        return {
          ok: false,
          reason: 'file-missing',
          checked: 'file-reference-grounding',
          evidence: { filePath },
        };
      }
      return { ok: true, reason: 'error', evidence: { filePath, errCode: code ?? null } };
    }
  }
}

// ---------------------------------------------------------------------------
// Arg-shape helpers
// ---------------------------------------------------------------------------

/**
 * File-path arg keys observed in the destructive-tool registry:
 *   - `file`        (meta.run-workflow, meta.enqueue-workflow)
 *   - `memoryPath`  (meta.memory-consolidate)
 *   - `file_path` / `filePath` / `path` (Edit-class convention, plus generic fs tools)
 *
 * Returns the first non-empty string match. Conservative: any non-string is
 * skipped rather than coerced. New keys land here only when a concrete tool
 * consumes them — speculative keys produce false-alarm stat calls on
 * non-path-shaped args.
 */
function pickFilePath(args: Record<string, unknown>): string | null {
  for (const k of ['file_path', 'filePath', 'path', 'file', 'memoryPath']) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * "Claimed prior content" arg keys (Edit-class):
 *   - `old_string` / `oldString` (canonical Edit shape)
 *
 * `find` / `search` are NOT included: `search` appears in non-edit tools
 * (web.search, MCP catalog search) where treating the value as expected file
 * content would mis-route a destructive call into edit-grounding.
 */
function pickOldString(args: Record<string, unknown>): string | null {
  for (const k of ['old_string', 'oldString']) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Heuristic for "this call is writing/creating content, so a missing file is
 * normal." If any of these keys carry a string value, skip file-reference
 * grounding (we don't want to false-alarm new-file writes).
 */
function hasWriteContent(args: Record<string, unknown>): boolean {
  for (const k of ['content', 'contents', 'body', 'new_string', 'newString']) {
    const v = args[k];
    if (typeof v === 'string') return true;
  }
  return false;
}
