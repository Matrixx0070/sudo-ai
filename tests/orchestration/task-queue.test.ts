/**
 * Tests for TaskQueue.findByIdPrefix and TaskQueue.pruneTerminal — the two
 * primitives behind the meta.task-manager "Task not found" fix and the new
 * `prune` action.
 *
 *  - findByIdPrefix: the list view shows only id.slice(0, 8); get/cancel must
 *    resolve that short prefix back to the full task (exact match wins; an
 *    ambiguous prefix returns every candidate; LIKE metacharacters are literal).
 *  - pruneTerminal: clears completed/cancelled/failed by age while leaving
 *    queued/running/blocked untouched.
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
  dir = mkdtempSync(join(tmpdir(), 'task-queue-'));
  dbPath = join(dir, 'mind.db');
  queue = new TaskQueue(dbPath, 4);
});

afterEach(() => {
  queue.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Open a second connection to backdate / inject rows the public API can't. */
function raw(): Database.Database {
  return new Database(dbPath);
}

describe('TaskQueue.findByIdPrefix', () => {
  it('returns the task for an exact full-id match', () => {
    const id = queue.enqueue({ name: 'work.a' });
    const matches = queue.findByIdPrefix(id);
    expect(matches.map(t => t.id)).toEqual([id]);
  });

  it('resolves the short 8-char prefix shown by list (the bug SUDO hit)', () => {
    const id = queue.enqueue({ name: 'work.b' });
    const shortId = id.slice(0, 8);
    const matches = queue.findByIdPrefix(shortId);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(id);
  });

  it('returns [] when nothing matches', () => {
    queue.enqueue({ name: 'work.c' });
    expect(queue.findByIdPrefix('zzzzzzzz')).toEqual([]);
  });

  it('returns every candidate for an ambiguous prefix', () => {
    const db = raw();
    db.prepare("INSERT INTO task_queue (id, name) VALUES ('abc12345-0000', 'x')").run();
    db.prepare("INSERT INTO task_queue (id, name) VALUES ('abc12399-1111', 'y')").run();
    db.close();

    const matches = queue.findByIdPrefix('abc123');
    expect(matches).toHaveLength(2);
    expect(matches.map(t => t.id).sort()).toEqual(['abc12345-0000', 'abc12399-1111']);
  });

  it('prefers an exact match even when it is a prefix of another id', () => {
    const db = raw();
    db.prepare("INSERT INTO task_queue (id, name) VALUES ('dead', 'short')").run();
    db.prepare("INSERT INTO task_queue (id, name) VALUES ('deadbeef', 'long')").run();
    db.close();

    const matches = queue.findByIdPrefix('dead');
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('dead');
  });

  it('treats LIKE metacharacters as literal', () => {
    const db = raw();
    db.prepare("INSERT INTO task_queue (id, name) VALUES ('a_b-1', 'underscore')").run();
    db.prepare("INSERT INTO task_queue (id, name) VALUES ('axb-2', 'wildcard-miss')").run();
    db.close();

    const matches = queue.findByIdPrefix('a_b');
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('a_b-1');
  });
});

describe('TaskQueue.pruneTerminal', () => {
  it('deletes completed, cancelled, and failed; keeps queued/running/blocked', () => {
    // running — enqueue first so it is the oldest ready task dequeue() picks
    const runId = queue.enqueue({ name: 'r' });
    const running = queue.dequeue();
    expect(running?.id).toBe(runId);
    expect(queue.getTask(runId)!.status).toBe('running');
    // queued (stays queued — never dequeued)
    queue.enqueue({ name: 'q' });
    // blocked (has a dependency)
    queue.enqueue({ name: 'b', dependsOn: ['missing-dep'] });
    // completed
    const doneId = queue.enqueue({ name: 'd' });
    queue.complete(doneId);
    // cancelled
    const canId = queue.enqueue({ name: 'c' });
    queue.cancel(canId);
    // failed (maxRetries 1 → one fail exhausts it)
    const failId = queue.enqueue({ name: 'f', maxRetries: 1 });
    queue.fail(failId, 'boom');
    expect(queue.getTask(failId)!.status).toBe('failed');

    const removed = queue.pruneTerminal(0); // 0 = all terminal regardless of age
    expect(removed).toBe(3);

    const stats = queue.getStats();
    expect(stats.completed).toBe(0);
    expect(stats.cancelled).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.queued).toBe(1);
    expect(stats.running).toBe(1);
    expect(stats.blocked).toBe(1);
  });

  it('honours the age cutoff — keeps recent terminal rows, deletes old ones', () => {
    const recentId = queue.enqueue({ name: 'recent' });
    queue.complete(recentId);
    const oldId = queue.enqueue({ name: 'old' });
    queue.complete(oldId);

    // Backdate the "old" row's completed_at to 30 days ago.
    const db = raw();
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    db.prepare('UPDATE task_queue SET completed_at = ? WHERE id = ?').run(old, oldId);
    db.close();

    const removed = queue.pruneTerminal(7); // older than 7 days
    expect(removed).toBe(1);
    expect(queue.getTask(oldId)).toBeNull();
    expect(queue.getTask(recentId)).not.toBeNull();
  });

  it('returns 0 when there is nothing to prune', () => {
    queue.enqueue({ name: 'still-queued' });
    expect(queue.pruneTerminal(0)).toBe(0);
  });
});
