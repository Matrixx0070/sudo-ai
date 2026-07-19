/**
 * @file onboard/audit.ts
 * @description BO12 / scorecard-S12 — hash-audit layer for the deterministic
 * `sudo-ai onboard` subcommand. Reuses BO10's `writeGuidanceAudited` discipline
 * (before/after sha256 + `.bak` + an append-only JSONL ledger line) but as a
 * generic file writer/remover so the onboard executor can audit BOTH seeded
 * workspace files and config writes (gateway token) through one ledger.
 *
 * Mirrors OpenClaw's `audit/crestodian.jsonl` (op + configHashBefore/After) and
 * `logs/config-audit.jsonl` (pid/argv/cwd/bytes/prev-next hash) in a single,
 * self-describing append-only record.
 *
 * NO LLM, NO network. Pure filesystem + crypto. `auditPath` is injectable so
 * tests exercise the audited write against a temp dir, never the real workspace.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Hex sha256 of a UTF-8 string. */
export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** One append-only audit record (mirrors crestodian.jsonl + config-audit.jsonl). */
export interface OnboardAuditRecord {
  /** Operation kind: seed a workspace file, write config, or reset-remove. */
  op: 'seed' | 'config-write' | 'reset-remove';
  /** Root-relative POSIX path that was touched. */
  relPath: string;
  configHashBefore: string;
  configHashAfter: string;
  bytesBefore: number;
  bytesAfter: number;
  /** Sibling `.bak` written before overwrite/removal, or null when file was absent. */
  bakPath: string | null;
  /** Process identity — mirrors config-audit.jsonl. */
  pid: number;
  cwd: string;
  ts: string;
}

/** Injectable audit context (temp-dir friendly). */
export interface AuditCtx {
  /** Absolute path to the append-only JSONL ledger. */
  auditPath: string;
  now?: () => string;
  pid?: number;
  cwd?: string;
}

/** Append a record to the ledger, creating the parent dir. Never throws upward. */
function appendLedger(ctx: AuditCtx, record: OnboardAuditRecord): void {
  try {
    fs.mkdirSync(path.dirname(ctx.auditPath), { recursive: true });
    fs.appendFileSync(ctx.auditPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // The write already landed; a ledger append failure must not crash onboard.
    // (The caller logs; onboarding continues gracefully like OpenClaw's.)
  }
}

/**
 * Hash-audited write of `content` to `absPath`. Writes a `.bak` of prior bytes
 * (when the file existed), writes the new content, appends a ledger record.
 * Returns the record. NUL-byte content is rejected before any I/O.
 */
export function writeFileAudited(
  absPath: string,
  content: string,
  relPath: string,
  op: OnboardAuditRecord['op'],
  ctx: AuditCtx,
): OnboardAuditRecord {
  if (typeof content !== 'string') throw new TypeError('content must be a string');
  if (content.includes('\x00')) throw new Error('content contains a NUL byte');

  let before = '';
  let existed = false;
  if (fs.existsSync(absPath)) {
    before = fs.readFileSync(absPath, 'utf-8');
    existed = true;
  }

  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  let bakPath: string | null = null;
  if (existed) {
    bakPath = absPath + '.bak';
    fs.writeFileSync(bakPath, before, 'utf-8');
  }
  fs.writeFileSync(absPath, content, 'utf-8');

  const record: OnboardAuditRecord = {
    op,
    relPath,
    configHashBefore: sha256(before),
    configHashAfter: sha256(content),
    bytesBefore: Buffer.byteLength(before, 'utf8'),
    bytesAfter: Buffer.byteLength(content, 'utf8'),
    bakPath,
    pid: ctx.pid ?? process.pid,
    cwd: ctx.cwd ?? process.cwd(),
    ts: (ctx.now ?? (() => new Date().toISOString()))(),
  };
  appendLedger(ctx, record);
  return record;
}

/**
 * Hash-audited removal of `absPath`. Backs up prior bytes to `.bak`, unlinks the
 * file, appends a `reset-remove` ledger record. Returns null (no ledger) when the
 * file was already absent — removal is idempotent.
 */
export function removeFileAudited(
  absPath: string,
  relPath: string,
  ctx: AuditCtx,
): OnboardAuditRecord | null {
  if (!fs.existsSync(absPath)) return null;
  const before = fs.readFileSync(absPath, 'utf-8');
  const bakPath = absPath + '.bak';
  fs.writeFileSync(bakPath, before, 'utf-8');
  fs.rmSync(absPath, { force: true });

  const record: OnboardAuditRecord = {
    op: 'reset-remove',
    relPath,
    configHashBefore: sha256(before),
    configHashAfter: sha256(''),
    bytesBefore: Buffer.byteLength(before, 'utf8'),
    bytesAfter: 0,
    bakPath,
    pid: ctx.pid ?? process.pid,
    cwd: ctx.cwd ?? process.cwd(),
    ts: (ctx.now ?? (() => new Date().toISOString()))(),
  };
  appendLedger(ctx, record);
  return record;
}
