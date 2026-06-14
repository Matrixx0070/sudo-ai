/**
 * @file memory-consolidator.ts
 * @description LLM-written memory consolidation (gap #20).
 *
 * Today MEMORY.md grows append-only via `AutoDream._promoteToMemoryMd`:
 * facts pile up as `- [YYYY-MM-DD] {fact}` lines until a 50 KB cap stops
 * appending. The Codex / Hermes "Curator" pattern is to periodically
 * REWRITE that file via an LLM pass that deduplicates, groups by theme,
 * and produces a tight human-readable summary — complementing RAG /
 * vector search rather than replacing it.
 *
 * This module is the LLM-driven rewrite primitive. It is intentionally
 * standalone (a single async function) so callers can:
 *
 *   - Trigger it from a meta tool the agent calls explicitly
 *     (`meta.memory-consolidate`)
 *   - Schedule it via an AutoDream phase
 *   - Run it from a cron-like operator script
 *
 * Safety:
 *
 *   - The OLD file is backed up to `<backupDir>/MEMORY.<ISO>.md` BEFORE
 *     any overwrite. A bad LLM output is recoverable by renaming the
 *     newest backup back over MEMORY.md.
 *   - The rewrite is rejected if it is empty, larger than the input plus
 *     a margin (we are SHRINKING, not growing), or fails the markdown-
 *     anchor sanity check (must contain at least one `# ` heading).
 *   - The write is atomic: write to `<path>.tmp`, fsync, rename.
 *   - On any failure, the original file is untouched.
 *
 * The brain call uses temperature 0.2 (deterministic-ish) and a strict
 * system prompt — the model is told to PRESERVE every load-bearing fact
 * and only drop verbatim duplicates / outdated entries.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  openSync,
} from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('memory:consolidator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal brain contract this module touches. Duck-typed so callers can
 * pass any object with a `call({messages, …}) → {content}` shape and the
 * tests can use a deterministic stub.
 */
export interface ConsolidatorBrain {
  call(opts: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

export interface ConsolidateOptions {
  /** Absolute path to MEMORY.md. The file must exist. */
  memoryPath: string;
  /**
   * Directory where the pre-rewrite backup is written
   * (`MEMORY.<ISO>.md`). Created if missing. Defaults to the parent dir
   * of memoryPath plus `.memory-backups/`.
   */
  backupDir?: string;
  /**
   * Custom system instruction. Falls back to the canonical Curator
   * prompt that preserves facts and groups by theme.
   */
  systemPrompt?: string;
  /**
   * Cap on accepted output bytes. The rewrite must be <= this. Default
   * `Math.max(input.length, 8192)` so a brand-new file (tiny input) can
   * still be expanded to a useful skeleton while a large file is held to
   * a shrink-or-equal contract.
   */
  maxOutputBytes?: number;
  /** Brain model override; default whatever brain.call resolves. */
  model?: string;
}

export interface ConsolidateResult {
  /** True when MEMORY.md was successfully overwritten. */
  consolidated: boolean;
  /** Bytes in the file BEFORE the rewrite. */
  inputBytes: number;
  /** Bytes in the file AFTER the rewrite (0 if rejected/skipped). */
  outputBytes: number;
  /** Path to the timestamped backup of the pre-rewrite content (if any). */
  backupPath: string | null;
  /** Human-readable reason the run skipped/rejected (when consolidated=false). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Default system prompt
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are a memory curator. The user will provide the current text of a long-running MEMORY.md file. Your job is to rewrite it into a tight, organized, human-readable form.

Strict rules:
  - PRESERVE every load-bearing fact. A fact is load-bearing if a future agent could plausibly need it to make a decision.
  - Drop verbatim duplicates and entries that are obviously outdated by a newer entry.
  - Group facts by theme using markdown level-2 headings (## Section name).
  - Keep dates where they are decision-relevant; drop them where they are noise.
  - Use markdown bullet lists for facts. No prose paragraphs.
  - Output ONLY the new MEMORY.md content — no preamble, no postscript, no code fences.
  - The first line MUST be a top-level markdown heading: '# Long-Term Memory'.
  - The output MUST be smaller than the input.
`;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Strip leading / trailing markdown code fences regardless of the language
 * tag (`markdown`, `md`, `text`, `plain`, `txt`, or bare). The broadened
 * `[a-z]*` matches what every other fence-stripper in this codebase does
 * (verifier MED #1).
 */
function stripCodeFence(s: string): string {
  return s.replace(/^```[a-z]*\s*\n/i, '').replace(/\n```\s*$/, '');
}

/**
 * Validate the brain output and return the canonical body bytes the
 * caller should write. On rejection returns `{ stripped: '', reason }`
 * so the caller can fail-loud with a structured message. Single source
 * of truth so the validated body and the written body cannot diverge
 * (verifier HIGH #2).
 */
function validateOutput(
  out: string,
  inputBytes: number,
  maxOutputBytes: number,
): { stripped: string; reason: string | null } {
  const trimmed = out.trim();
  if (!trimmed) return { stripped: '', reason: 'output is empty' };
  const stripped = stripCodeFence(trimmed);
  if (!stripped.trim()) return { stripped: '', reason: 'output is empty after fence strip' };
  if (!/^# /m.test(stripped)) return { stripped: '', reason: 'output has no top-level # heading' };
  const outBytes = Buffer.byteLength(stripped, 'utf-8');
  if (outBytes > maxOutputBytes) {
    return { stripped: '', reason: `output ${outBytes} bytes exceeds max ${maxOutputBytes}` };
  }
  // Shrink contract: the rewrite of a file that already has content must
  // not grow the file. Allow a tiny growth margin for the case where the
  // input was a few facts and the curator adds the canonical heading.
  if (inputBytes > 2048 && outBytes > inputBytes) {
    return { stripped: '', reason: `consolidation grew the file (${inputBytes} → ${outBytes}); refusing to overwrite` };
  }
  return { stripped, reason: null };
}

// ---------------------------------------------------------------------------
// fsync helper
// ---------------------------------------------------------------------------

function fsyncBestEffort(filePath: string): void {
  try {
    const fd = openSync(filePath, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // Best-effort: the rename happened, the durability flush is a bonus.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rewrite MEMORY.md via an LLM pass. The original is backed up before
 * any overwrite; a bad output is rejected and the original is untouched.
 *
 * Returns `{ consolidated, inputBytes, outputBytes, backupPath, reason }`
 * — the caller can log/report without unpacking errors itself.
 */
export async function consolidateMemoryFile(
  brain: ConsolidatorBrain,
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  const memoryPath = opts.memoryPath;
  if (!memoryPath) {
    throw new TypeError('consolidateMemoryFile: opts.memoryPath is required');
  }
  if (!brain || typeof brain.call !== 'function') {
    throw new TypeError('consolidateMemoryFile: brain must have a .call() method');
  }
  if (!existsSync(memoryPath)) {
    return {
      consolidated: false,
      inputBytes: 0,
      outputBytes: 0,
      backupPath: null,
      reason: `MEMORY.md does not exist at ${memoryPath}`,
    };
  }

  const inputText = readFileSync(memoryPath, 'utf-8');
  const inputBytes = Buffer.byteLength(inputText, 'utf-8');
  if (inputBytes === 0) {
    return {
      consolidated: false,
      inputBytes: 0,
      outputBytes: 0,
      backupPath: null,
      reason: 'MEMORY.md is empty — nothing to consolidate',
    };
  }

  const maxOutputBytes = opts.maxOutputBytes ?? Math.max(inputBytes, 8192);
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const backupDir = opts.backupDir ?? path.join(path.dirname(memoryPath), '.memory-backups');

  // 1. Brain call
  let raw: string;
  try {
    const response = await brain.call({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content:
            `Rewrite this MEMORY.md file. Keep every load-bearing fact, drop duplicates, group by theme.\n\n` +
            `--- CURRENT MEMORY.MD ---\n${inputText}\n--- END ---\n`,
        },
      ],
      model: opts.model,
      temperature: 0.2,
      maxTokens: 4096,
    });
    raw = response.content ?? '';
  } catch (err) {
    return {
      consolidated: false,
      inputBytes,
      outputBytes: 0,
      backupPath: null,
      reason: `brain call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Validate output. validateOutput returns the stripped body it
  // approved so the bytes we write are the SAME bytes we validated
  // (verifier HIGH #2 — the previous double-strip could diverge).
  const { stripped: newContent, reason: rejectReason } = validateOutput(raw, inputBytes, maxOutputBytes);
  if (rejectReason !== null) {
    log.warn({ memoryPath, rejectReason }, 'consolidation output rejected — original untouched');
    return {
      consolidated: false,
      inputBytes,
      outputBytes: 0,
      backupPath: null,
      reason: rejectReason,
    };
  }

  // 3. Backup original
  try {
    mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    return {
      consolidated: false,
      inputBytes,
      outputBytes: 0,
      backupPath: null,
      reason: `cannot create backup dir ${backupDir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `MEMORY.${iso}.md`);
  try {
    writeFileSync(backupPath, inputText, 'utf-8');
    fsyncBestEffort(backupPath);
  } catch (err) {
    return {
      consolidated: false,
      inputBytes,
      outputBytes: 0,
      backupPath: null,
      reason: `cannot write backup ${backupPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Atomic write to MEMORY.md
  const tmpPath = memoryPath + '.tmp';
  try {
    writeFileSync(tmpPath, newContent, 'utf-8');
    fsyncBestEffort(tmpPath);
    renameSync(tmpPath, memoryPath);
    fsyncBestEffort(memoryPath);
  } catch (err) {
    // Roll back: try to remove the orphaned tmp file.
    try { if (existsSync(tmpPath)) rmSync(tmpPath); } catch { /* ignore */ }
    return {
      consolidated: false,
      inputBytes,
      outputBytes: 0,
      backupPath,
      reason: `atomic write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const outputBytes = statSync(memoryPath).size;
  log.info(
    { memoryPath, inputBytes, outputBytes, backupPath, shrinkPct: Math.round((1 - outputBytes / inputBytes) * 100) },
    'MEMORY.md consolidated',
  );
  return {
    consolidated: true,
    inputBytes,
    outputBytes,
    backupPath,
  };
}

/**
 * Lightweight heuristic: should we run a consolidation pass now? Returns
 * true when the file exists and is at least `minBytes` long. Callers can
 * layer their own age / since-last-run logic on top.
 */
export function shouldConsolidate(memoryPath: string, minBytes = 8192): boolean {
  try {
    if (!existsSync(memoryPath)) return false;
    return statSync(memoryPath).size >= minBytes;
  } catch {
    return false;
  }
}
