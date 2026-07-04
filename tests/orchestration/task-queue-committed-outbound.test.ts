/**
 * Run-level outbound gate: a task whose run committed an external side effect
 * (sent a message, spawned a sub-agent, created a cron job) must NOT be
 * auto-requeued on failure — a re-run would re-fire it. TaskQueue.fail() forces a
 * terminal fail, and retryFailed() skips such tasks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskQueue } from '../../src/core/orchestration/task-queue.js';

let dir: string;
let dbPath: string;
let queue: TaskQueue;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-queue-co-'));
  dbPath = join(dir, 'mind.db');
  queue = new TaskQueue(dbPath, 4);
});
afterEach(() => {
  queue.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('TaskQueue committed-outbound gate', () => {
  it('fail() requeues a normal task with retries remaining', () => {
    const id = queue.enqueue({ name: 'work', maxRetries: 3 });
    queue.dequeue();
    queue.fail(id, 'boom');
    expect(queue.getTask(id)!.status).toBe('queued'); // auto-retry
  });

  it('fail() forces a TERMINAL fail once the task committed outbound', () => {
    const id = queue.enqueue({ name: 'send-slack', maxRetries: 3 });
    queue.dequeue();
    queue.markCommittedOutbound(id);
    queue.fail(id, 'threw after sending');
    // Retries remain (0 < 3) but it must NOT requeue — that would re-send.
    expect(queue.getTask(id)!.status).toBe('failed');
  });

  it('retryFailed() skips committed-outbound tasks', () => {
    const plain = queue.enqueue({ name: 'plain', maxRetries: 3 });
    const sent = queue.enqueue({ name: 'sent', maxRetries: 3 });
    for (const id of [plain, sent]) { queue.dequeue(); }
    queue.markCommittedOutbound(sent);
    // Drive both to terminal 'failed' (committed one already terminal; plain needs exhaustion).
    queue.fail(sent, 'e');                       // terminal via gate
    const raw = new Database(dbPath);
    raw.prepare("UPDATE task_queue SET status='failed', retries=1 WHERE id=?").run(plain);
    raw.close();

    const requeued = queue.retryFailed();
    expect(requeued).toBe(1); // only the plain task
    expect(queue.getTask(plain)!.status).toBe('queued');
    expect(queue.getTask(sent)!.status).toBe('failed'); // still gated
  });

  it('migrates an existing DB that predates the committed_outbound column', () => {
    queue.close();
    // Build a task_queue WITHOUT the column, the way an old build would have.
    const legacy = new Database(dbPath);
    legacy.exec('DROP TABLE IF EXISTS task_queue');
    legacy.exec(`CREATE TABLE task_queue (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'queued',
      depends_on TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL DEFAULT '{}',
      result TEXT, error TEXT, retries INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3, timeout_ms INTEGER NOT NULL DEFAULT 120000,
      created_at TEXT NOT NULL DEFAULT '2026-01-01', started_at TEXT, completed_at TEXT,
      created_by TEXT NOT NULL DEFAULT 'system'
    )`);
    legacy.close();

    // Re-opening through TaskQueue must add the column and work.
    const migrated = new TaskQueue(dbPath, 4);
    const id = migrated.enqueue({ name: 'after-migrate', maxRetries: 3 });
    migrated.dequeue();
    migrated.markCommittedOutbound(id);
    migrated.fail(id, 'e');
    expect(migrated.getTask(id)!.status).toBe('failed'); // gate works post-migration
    migrated.close();
  });
});
