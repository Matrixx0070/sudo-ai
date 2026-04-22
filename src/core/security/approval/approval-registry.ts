/**
 * File-backed approval queue for the exec approval gate.
 *
 * Pending requests live at workspace/approvals/pending/<uuid>.json.
 * Decided requests are moved to workspace/approvals/decided/<uuid>.json.
 *
 * All writes are atomic: we write to <file>.tmp then rename, so a reader
 * never sees a partial JSON file.
 *
 * UUID validation is enforced on every method that accepts an id parameter
 * to prevent path traversal attacks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../shared/logger.js';
import type { ApprovalRecord, ApprovalDecision } from './types.js';
import { isValidUuid } from './types.js';

const log = createLogger('security:approval');

// ---------------------------------------------------------------------------
// Directory layout
// ---------------------------------------------------------------------------

/** Base directory for approval files. Resolved from cwd at module load time. */
const APPROVALS_BASE = path.resolve('workspace/approvals');
const PENDING_DIR = path.join(APPROVALS_BASE, 'pending');
const DECIDED_DIR = path.join(APPROVALS_BASE, 'decided');

/** TTL for approval records before they expire (30 minutes). */
export const APPROVAL_EXPIRY_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Startup: ensure directories exist
// ---------------------------------------------------------------------------

function ensureDirs(): void {
  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.mkdirSync(DECIDED_DIR, { recursive: true });
  } catch (err) {
    log.error({ err: String(err) }, 'approval-registry: failed to create approval directories');
  }
}

ensureDirs();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pendingPath(id: string): string {
  return path.join(PENDING_DIR, `${id}.json`);
}

function decidedPath(id: string): string {
  return path.join(DECIDED_DIR, `${id}.json`);
}

/** Atomic write: write to .tmp then rename. Throws on failure. */
function writeAtomic(filePath: string, record: ApprovalRecord): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Read and validate an ApprovalRecord from disk. Returns null on any error. */
function readRecord(filePath: string): ApprovalRecord | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isApprovalRecord(parsed)) {
      log.warn({ filePath }, 'approval-registry: invalid record schema');
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Strict type guard for ApprovalRecord. Validates all required fields. */
function isApprovalRecord(value: unknown): value is ApprovalRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    isValidUuid(r['id']) &&
    typeof r['command'] === 'string' &&
    typeof r['reason'] === 'string' &&
    typeof r['requestedAt'] === 'string' &&
    (r['decidedAt'] === undefined || typeof r['decidedAt'] === 'string') &&
    (r['decision'] === 'approved' ||
      r['decision'] === 'denied' ||
      r['decision'] === 'pending' ||
      r['decision'] === 'expired')
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a new pending approval request to disk.
 *
 * @param command - The shell command string awaiting approval.
 * @param reason  - Optional human-readable explanation from the agent.
 * @returns The UUID of the new approval request.
 */
export async function requestApproval(command: string, reason = ''): Promise<string> {
  ensureDirs();
  const id = randomUUID();
  const record: ApprovalRecord = {
    id,
    command,
    reason,
    requestedAt: new Date().toISOString(),
    decision: 'pending',
  };
  const filePath = pendingPath(id);
  writeAtomic(filePath, record);
  log.info({ id, command: command.slice(0, 120) }, 'approval-registry: approval requested');
  return id;
}

/**
 * Poll for a decision on a pending approval request.
 *
 * Checks the decided directory immediately, then polls every 500ms until a
 * decision file appears or the timeout elapses.
 *
 * @param id        - UUID of the approval request.
 * @param timeoutMs - Maximum time to wait before returning 'expired'.
 * @returns The final decision: 'approved', 'denied', or 'expired'.
 */
export function waitForDecision(
  id: string,
  timeoutMs: number,
): Promise<'approved' | 'denied' | 'expired'> {
  if (!isValidUuid(id)) {
    return Promise.resolve('expired');
  }

  return new Promise((resolve) => {
    const dFilePath = decidedPath(id);
    const POLL_INTERVAL = 500;

    function checkDecision(): 'approved' | 'denied' | null {
      const record = readRecord(dFilePath);
      if (!record) return null;
      if (record.decision === 'approved') return 'approved';
      if (record.decision === 'denied') return 'denied';
      return null;
    }

    // Immediate check at t=0 before starting any timer
    const immediate = checkDecision();
    if (immediate !== null) {
      resolve(immediate);
      return;
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    function settle(result: 'approved' | 'denied' | 'expired'): void {
      if (settled) return;
      settled = true;
      if (intervalId !== null) clearInterval(intervalId);
      if (timeoutId !== null) clearTimeout(timeoutId);
      log.info({ id, result }, 'approval-registry: decision received');
      resolve(result);
    }

    intervalId = setInterval(() => {
      const decision = checkDecision();
      if (decision !== null) settle(decision);
    }, POLL_INTERVAL);

    timeoutId = setTimeout(() => settle('expired'), timeoutMs);
  });
}

/**
 * Approve a pending request by writing a decided record.
 * Called externally (e.g. via CLI: sudo-ai approve <id>).
 *
 * @param id - UUID of the approval request to approve.
 */
export async function approve(id: string): Promise<void> {
  if (!isValidUuid(id)) throw new Error(`approve: invalid approval ID: ${id}`);

  const pFile = pendingPath(id);
  const dFile = decidedPath(id);

  const record = readRecord(pFile);
  if (!record) throw new Error(`approve: pending request not found: ${id}`);

  const decided: ApprovalRecord = {
    ...record,
    decidedAt: new Date().toISOString(),
    decision: 'approved',
  };

  ensureDirs();
  writeAtomic(dFile, decided);

  // Remove the pending file after writing decided (non-fatal if it fails)
  try { fs.unlinkSync(pFile); } catch { /* already cleaned up or race */ }

  log.info({ id }, 'approval-registry: approved');
}

/**
 * Deny a pending request.
 *
 * @param id - UUID of the approval request to deny.
 */
export async function deny(id: string): Promise<void> {
  if (!isValidUuid(id)) throw new Error(`deny: invalid approval ID: ${id}`);

  const pFile = pendingPath(id);
  const dFile = decidedPath(id);

  const record = readRecord(pFile);
  if (!record) throw new Error(`deny: pending request not found: ${id}`);

  const decided: ApprovalRecord = {
    ...record,
    decidedAt: new Date().toISOString(),
    decision: 'denied',
  };

  ensureDirs();
  writeAtomic(dFile, decided);

  try { fs.unlinkSync(pFile); } catch { /* already cleaned up or race */ }

  log.info({ id }, 'approval-registry: denied');
}

/**
 * List all currently pending approval requests.
 *
 * @returns Array of valid ApprovalRecord objects from the pending directory.
 */
export async function listPending(): Promise<ApprovalRecord[]> {
  ensureDirs();
  let files: string[];
  try {
    files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const results: ApprovalRecord[] = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    if (!isValidUuid(id)) continue;
    const record = readRecord(path.join(PENDING_DIR, file));
    if (record) results.push(record);
  }
  return results;
}
