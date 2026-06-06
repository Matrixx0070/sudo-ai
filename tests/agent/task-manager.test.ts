/**
 * Tests for task-manager.ts — user-facing task management.
 *
 * Covers: CRUD, dependencies, assignment, status transitions,
 * hook emission, persistence, filtering, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskManager } from '../../src/core/agent/task-manager.js';
import type { ManagedTask, TaskManagerStatus, TaskListFilter } from '../../src/core/agent/task-manager.js';
import { HookManager } from '../../src/core/hooks/index.js';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_PERSIST_DIR = path.resolve('data/tasks/_test_tm');

function cleanup(): void {
  if (existsSync(TEST_PERSIST_DIR)) {
    rmSync(TEST_PERSIST_DIR, { recursive: true, force: true });
  }
}

function freshManager(sessionId?: string, hooks?: HookManager): TaskManager {
  return new TaskManager(sessionId ?? `test-${Date.now()}`, {
    persistDir: TEST_PERSIST_DIR,
    hooks,
  });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('TaskManager — CRUD', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('createTask: creates a task with defaults', () => {
    const tm = freshManager();
    const task = tm.createTask({ subject: 'Deploy API' });

    expect(task.id).toBeTruthy();
    expect(task.subject).toBe('Deploy API');
    expect(task.description).toBe('');
    expect(task.status).toBe('pending');
    expect(task.owner).toBe('');
    expect(task.priority).toBe(0);
    expect(task.blockedBy).toEqual([]);
    expect(task.blocks).toEqual([]);
    expect(task.createdAt).toBeTruthy();
    expect(task.updatedAt).toBeTruthy();
    expect(task.completedAt).toBeUndefined();
  });

  it('createTask: accepts optional fields', () => {
    const tm = freshManager();
    const task = tm.createTask({
      subject: 'Run tests',
      description: 'Full regression suite',
      owner: 'agent-1',
      priority: 7,
    });

    expect(task.description).toBe('Full regression suite');
    expect(task.owner).toBe('agent-1');
    expect(task.priority).toBe(7);
  });

  it('createTask: throws on missing subject', () => {
    const tm = freshManager();
    expect(() => tm.createTask({ subject: '' })).toThrow(TypeError);
    expect(() => tm.createTask({ subject: undefined as any })).toThrow(TypeError);
  });

  it('updateTask: updates mutable fields', () => {
    const tm = freshManager();
    const task = tm.createTask({ subject: 'Initial' });

    const updated = tm.updateTask(task.id, {
      subject: 'Updated',
      description: 'New desc',
      priority: 10,
    });

    expect(updated!.subject).toBe('Updated');
    expect(updated!.description).toBe('New desc');
    expect(updated!.priority).toBe(10);
  });

  it('updateTask: transitions pending → in_progress → completed', () => {
    const tm = freshManager();
    const task = tm.createTask({ subject: 'Step 1' });

    tm.updateTask(task.id, { status: 'in_progress' });
    expect(tm.getTask(task.id)!.status).toBe('in_progress');

    tm.updateTask(task.id, { status: 'completed' });
    const completed = tm.getTask(task.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeTruthy();
  });

  it('updateTask: rejects invalid status transitions', () => {
    const tm = freshManager();
    const task = tm.createTask({ subject: 'Step' });

    // Complete directly, then try to go back.
    tm.updateTask(task.id, { status: 'completed' });

    const result = tm.updateTask(task.id, { status: 'in_progress' as TaskManagerStatus });
    // Status should remain completed — invalid transition is rejected.
    expect(result!.status).toBe('completed');
  });

  it('updateTask: returns undefined for unknown ID', () => {
    const tm = freshManager();
    expect(tm.updateTask('nonexistent', { subject: 'x' })).toBeUndefined();
  });

  it('getTask: retrieves by ID', () => {
    const tm = freshManager();
    const task = tm.createTask({ subject: 'Find me' });
    expect(tm.getTask(task.id)).toEqual(task);
    expect(tm.getTask('nope')).toBeUndefined();
  });

  it('deleteTask: removes task and cleans up dependency links', () => {
    const tm = freshManager();
    const t1 = tm.createTask({ subject: 'Blocker' });
    const t2 = tm.createTask({ subject: 'Dependent' });
    tm.addBlocks(t2.id, [t1.id]);

    expect(tm.deleteTask(t1.id)).toBe(true);
    // t2's blockedBy should no longer reference t1.
    expect(tm.getTask(t2.id)!.blockedBy).toEqual([]);
    expect(tm.getTask(t1.id)).toBeUndefined();
  });

  it('deleteTask: returns false for unknown ID', () => {
    const tm = freshManager();
    expect(tm.deleteTask('ghost')).toBe(false);
  });

  it('listTasks: returns all tasks sorted by priority desc then createdAt asc', () => {
    const tm = freshManager();
    const low = tm.createTask({ subject: 'Low', priority: 1 });
    const high = tm.createTask({ subject: 'High', priority: 10 });
    const mid = tm.createTask({ subject: 'Mid', priority: 5 });

    const list = tm.listTasks();
    expect(list.map((t) => t.id)).toEqual([high.id, mid.id, low.id]);
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('TaskManager — listTasks filtering', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('filters by status', () => {
    const tm = freshManager();
    const t1 = tm.createTask({ subject: 'Pending A' });
    const t2 = tm.createTask({ subject: 'Pending B' });
    tm.updateTask(t1.id, { status: 'completed' });

    const completed = tm.listTasks({ status: 'completed' });
    expect(completed.length).toBe(1);
    expect(completed[0].id).toBe(t1.id);
  });

  it('filters by owner', () => {
    const tm = freshManager();
    const t1 = tm.createTask({ subject: 'A', owner: 'agent-x' });
    const t2 = tm.createTask({ subject: 'B', owner: 'agent-y' });

    const owned = tm.listTasks({ owner: 'agent-x' });
    expect(owned.length).toBe(1);
    expect(owned[0].id).toBe(t1.id);
  });

  it('filters by priority range', () => {
    const tm = freshManager();
    tm.createTask({ subject: 'Low', priority: 1 });
    tm.createTask({ subject: 'Mid', priority: 5 });
    tm.createTask({ subject: 'High', priority: 10 });

    const mid = tm.listTasks({ priorityMin: 3, priorityMax: 7 });
    expect(mid.length).toBe(1);
    expect(mid[0].subject).toBe('Mid');
  });

  it('filters by blocked status', () => {
    const tm = freshManager();
    const t1 = tm.createTask({ subject: 'Blocker' });
    const t2 = tm.createTask({ subject: 'Free' });
    tm.addBlocks(t2.id, [t1.id]);

    const blocked = tm.listTasks({ blocked: true });
    expect(blocked.length).toBe(1);
    expect(blocked[0].id).toBe(t2.id);

    const unblocked = tm.listTasks({ blocked: false });
    expect(unblocked.some((t) => t.id === t1.id)).toBe(true);
    expect(unblocked.some((t) => t.id === t2.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

describe('TaskManager — dependencies', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('addBlocks: establishes bidirectional dependency links', () => {
    const tm = freshManager();
    const t1 = tm.createTask({ subject: 'Blocker' });
    const t2 = tm.createTask({ subject: 'Dependent' });

    tm.addBlocks(t2.id, [t1.id]);

    const updated = tm.getTask(t2.id)!;
    expect(updated.blockedBy).toContain(t1.id);

    const blocker = tm.getTask(t1.id)!;
    expect(blocker.blocks).toContain(t2.id);
  });

  it('addBlocks: skips self-blocking', () => {
    const tm = freshManager();
    const t1 = tm.createTask({ subject: 'Self' });
    tm.addBlocks(t1.id, [t1.id]);
    expect(tm.getTask(t1.id)!.blockedBy).toEqual([]);
  });

  it('addBlocks: deduplicates existing blockers', () => {
    const tm = freshManager();
    const t1 = tm.createTask({ subject: 'Blocker' });
    const t2 = tm.createTask({ subject: 'Dependent' });

    tm.addBlocks(t2.id, [t1.id]);
    tm.addBlocks(t2.id, [t1.id]); // duplicate

    expect(tm.getTask(t2.id)!.blockedBy).toEqual([t1.id]);
  });

  it('removeBlocks: removes bidirectional links', () => {
    const tm = freshManager();
    const t1 = tm.createTask({ subject: 'Blocker' });
    const t2 = tm.createTask({ subject: 'Dependent' });
    tm.addBlocks(t2.id, [t1.id]);

    tm.removeBlocks(t2.id, [t1.id]);

    expect(tm.getTask(t2.id)!.blockedBy).toEqual([]);
    expect(tm.getTask(t1.id)!.blocks).toEqual([]);
  });

  it('completion propagates unblock to dependants', () => {
    const tm = freshManager();
    const t1 = tm.createTask({ subject: 'Blocker' });
    const t2 = tm.createTask({ subject: 'Dependent' });
    tm.addBlocks(t2.id, [t1.id]);

    // Completing t1 should remove it from t2's blockedBy.
    tm.updateTask(t1.id, { status: 'completed' });
    expect(tm.getTask(t2.id)!.blockedBy).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe('TaskManager — assignment', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('assignTo: sets the owner', () => {
    const tm = freshManager();
    const task = tm.createTask({ subject: 'Work' });

    const updated = tm.assignTo(task.id, 'agent-42');
    expect(updated!.owner).toBe('agent-42');
  });

  it('assignTo: throws on empty owner', () => {
    const tm = freshManager();
    const task = tm.createTask({ subject: 'Work' });
    expect(() => tm.assignTo(task.id, '')).toThrow(TypeError);
  });

  it('unassign: clears the owner', () => {
    const tm = freshManager();
    const task = tm.createTask({ subject: 'Work', owner: 'agent-1' });

    const updated = tm.unassign(task.id);
    expect(updated!.owner).toBe('');
  });

  it('assignTo/unassign: return undefined for unknown ID', () => {
    const tm = freshManager();
    expect(tm.assignTo('ghost', 'x')).toBeUndefined();
    expect(tm.unassign('ghost')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

describe('TaskManager — hooks', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('fires task:created hook on createTask', async () => {
    const hooks = new HookManager();
    const handler = vi.fn().mockResolvedValue(undefined);
    hooks.register('task:created', handler, 'test created hook');

    const tm = freshManager('hook-test-1', hooks);
    tm.createTask({ subject: 'Hook test' });

    // Allow async hook to flush.
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledOnce();
    const ctx = handler.mock.calls[0][0];
    expect(ctx.event).toBe('task:created');
    expect(ctx.meta?.subject).toBe('Hook test');
  });

  it('fires task:completed hook on status → completed', async () => {
    const hooks = new HookManager();
    const handler = vi.fn().mockResolvedValue(undefined);
    hooks.register('task:completed', handler, 'test completed hook');

    const tm = freshManager('hook-test-2', hooks);
    const task = tm.createTask({ subject: 'Finish me' });
    tm.updateTask(task.id, { status: 'completed' });

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledOnce();
    const ctx = handler.mock.calls[0][0];
    expect(ctx.event).toBe('task:completed');
    expect(ctx.meta?.taskId).toBe(task.id);
  });

  it('does not fire task:completed for non-completion updates', async () => {
    const hooks = new HookManager();
    const handler = vi.fn().mockResolvedValue(undefined);
    hooks.register('task:completed', handler, 'should not fire');

    const tm = freshManager('hook-test-3', hooks);
    const task = tm.createTask({ subject: 'In progress' });
    tm.updateTask(task.id, { status: 'in_progress' });

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('TaskManager — persistence', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('save + load: round-trips tasks to disk', () => {
    const sid = 'persist-test-1';
    const tm1 = freshManager(sid);
    const t1 = tm1.createTask({ subject: 'Persist me', priority: 8 });
    tm1.save();

    // Create a second manager with the same session — should load from disk.
    const tm2 = freshManager(sid);
    expect(tm2.size).toBe(1);
    const loaded = tm2.getTask(t1.id);
    expect(loaded).toBeTruthy();
    expect(loaded!.subject).toBe('Persist me');
    expect(loaded!.priority).toBe(8);
  });

  it('isDirty tracks unsaved changes', () => {
    const tm = freshManager();
    expect(tm.isDirty).toBe(false);

    tm.createTask({ subject: 'New task' });
    expect(tm.isDirty).toBe(true);

    tm.save();
    expect(tm.isDirty).toBe(false);
  });

  it('loads empty state when no file exists', () => {
    const tm = freshManager('no-such-session');
    expect(tm.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('TaskManager — constructor', () => {
  it('throws on empty sessionId', () => {
    expect(() => new TaskManager('')).toThrow(TypeError);
    expect(() => new TaskManager(undefined as any)).toThrow(TypeError);
  });

  it('exposes sessionId via id property', () => {
    const tm = freshManager('my-session');
    expect(tm.id).toBe('my-session');
  });
});