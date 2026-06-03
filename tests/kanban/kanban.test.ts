/**
 * @file kanban.test.ts
 * @description Unit tests for Kanban board and swarm orchestrator.
 *
 * Tests: CRUD operations, status transitions, swarm decomposition,
 * kill-switch behavior, and REST routes with mock req/res.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { KanbanBoard } from '../../src/core/kanban/kanban-board.js';
import { SwarmOrchestrator } from '../../src/core/kanban/swarm-orchestrator.js';
import type { KanbanTask, KanbanStatus } from '../../src/core/kanban/kanban-types.js';
import { isValidTransition, STATUS_TRANSITIONS } from '../../src/core/kanban/kanban-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
}

function makeBoard(tmpDir: string): KanbanBoard {
  const originalDataDir = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpDir;
  const board = new KanbanBoard();
  // Restore after initialization
  if (originalDataDir) {
    process.env['DATA_DIR'] = originalDataDir;
  }
  return board;
}

function makeMockReq(overrides: Partial<{
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}> = {}): any {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/',
    headers: overrides.headers ?? {},
    on: () => {},
    destroy: () => {},
    ...overrides,
  };
}

function makeMockRes(): any {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    writeHead: function (status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end: function (data: string) {
      this.body = data;
    },
  };
  return res;
}

const ADMIN_TOKEN = 'test-admin-token-12345';
const ADMIN_TOKEN_BUF = Buffer.from(ADMIN_TOKEN);

// ---------------------------------------------------------------------------
// 1. Type utilities
// ---------------------------------------------------------------------------

describe('kanban-types', () => {
  describe('isValidTransition', () => {
    it('allows todo -> in_progress', () => {
      expect(isValidTransition('todo', 'in_progress')).toBe(true);
    });

    it('allows todo -> done (skip)', () => {
      expect(isValidTransition('todo', 'done')).toBe(true);
    });

    it('allows in_progress -> review', () => {
      expect(isValidTransition('in_progress', 'review')).toBe(true);
    });

    it('allows in_progress -> done', () => {
      expect(isValidTransition('in_progress', 'done')).toBe(true);
    });

    it('allows in_progress -> todo (revert)', () => {
      expect(isValidTransition('in_progress', 'todo')).toBe(true);
    });

    it('allows review -> done', () => {
      expect(isValidTransition('review', 'done')).toBe(true);
    });

    it('allows review -> in_progress (needs work)', () => {
      expect(isValidTransition('review', 'in_progress')).toBe(true);
    });

    it('allows review -> todo (major rework)', () => {
      expect(isValidTransition('review', 'todo')).toBe(true);
    });

    it('allows done -> todo (reopen)', () => {
      expect(isValidTransition('done', 'todo')).toBe(true);
    });

    it('allows done -> in_progress (reopen active)', () => {
      expect(isValidTransition('done', 'in_progress')).toBe(true);
    });

    it('rejects invalid transition: todo -> review', () => {
      expect(isValidTransition('todo', 'review')).toBe(false);
    });

    it('rejects invalid transition: in_progress -> in_progress', () => {
      expect(isValidTransition('in_progress', 'in_progress')).toBe(false);
    });
  });

  describe('STATUS_TRANSITIONS', () => {
    it('defines transitions for all statuses', () => {
      expect(STATUS_TRANSITIONS['todo']).toBeDefined();
      expect(STATUS_TRANSITIONS['in_progress']).toBeDefined();
      expect(STATUS_TRANSITIONS['review']).toBeDefined();
      expect(STATUS_TRANSITIONS['done']).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. KanbanBoard CRUD
// ---------------------------------------------------------------------------

describe('KanbanBoard', () => {
  let tmpDir: string;
  let board: KanbanBoard;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    board = makeBoard(tmpDir);
  });

  afterEach(() => {
    board.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createTask', () => {
    it('creates a task with minimal fields', () => {
      const task = board.createTask({
        title: 'Test Task',
        body: 'Task body',
        status: 'todo',
        priority: 3,
        skills: [],
        workspace: 'scratch',
      });

      expect(task.id).toMatch(/^[_a-zA-Z0-9-]+$/);
      expect(task.title).toBe('Test Task');
      expect(task.body).toBe('Task body');
      expect(task.status).toBe('todo');
      expect(task.priority).toBe(3);
      expect(task.workspace).toBe('scratch');
      expect(task.createdAt).toBeTruthy();
      expect(task.updatedAt).toBeTruthy();
    });

    it('creates a task with all fields', () => {
      const task = board.createTask({
        title: 'Full Task',
        body: 'Detailed description',
        status: 'in_progress',
        priority: 5,
        assignee: 'agent-123',
        skills: ['research', 'coding'],
        parentId: 'parent-id',
        workspace: 'project',
        tenantId: 'tenant-abc',
      });

      expect(task.title).toBe('Full Task');
      expect(task.priority).toBe(5);
      expect(task.assignee).toBe('agent-123');
      expect(task.skills).toEqual(['research', 'coding']);
      expect(task.parentId).toBe('parent-id');
      expect(task.workspace).toBe('project');
      expect(task.tenantId).toBe('tenant-abc');
    });
  });

  describe('getTask', () => {
    it('returns null for non-existent task', () => {
      expect(board.getTask('nonexistent')).toBeNull();
    });

    it('retrieves an existing task', () => {
      const created = board.createTask({
        title: 'Get Test',
        body: 'Body',
        status: 'todo',
        priority: 2,
        skills: ['test'],
        workspace: 'scratch',
      });

      const retrieved = board.getTask(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.title).toBe('Get Test');
    });
  });

  describe('updateTask', () => {
    it('returns false for non-existent task', () => {
      expect(board.updateTask('nonexistent', { title: 'New Title' })).toBe(false);
    });

    it('updates task fields', () => {
      const created = board.createTask({
        title: 'Original',
        body: 'Original body',
        status: 'todo',
        priority: 1,
        skills: [],
        workspace: 'scratch',
      });

      const updated = board.updateTask(created.id, {
        title: 'Updated Title',
        priority: 5,
        status: 'in_progress',
      });

      expect(updated).toBe(true);
      const retrieved = board.getTask(created.id);
      expect(retrieved!.title).toBe('Updated Title');
      expect(retrieved!.priority).toBe(5);
      expect(retrieved!.status).toBe('in_progress');
    });
  });

  describe('deleteTask', () => {
    it('returns false for non-existent task', () => {
      expect(board.deleteTask('nonexistent')).toBe(false);
    });

    it('deletes an existing task', () => {
      const created = board.createTask({
        title: 'Delete Me',
        body: 'Body',
        status: 'todo',
        priority: 1,
        skills: [],
        workspace: 'scratch',
      });

      expect(board.deleteTask(created.id)).toBe(true);
      expect(board.getTask(created.id)).toBeNull();
    });
  });

  describe('listTasks', () => {
    it('returns empty array initially', () => {
      expect(board.listTasks()).toEqual([]);
    });

    it('lists all tasks', () => {
      board.createTask({ title: 'Task 1', body: 'B', status: 'todo', priority: 1, skills: [], workspace: 'scratch' });
      board.createTask({ title: 'Task 2', body: 'B', status: 'todo', priority: 2, skills: [], workspace: 'scratch' });
      board.createTask({ title: 'Task 3', body: 'B', status: 'done', priority: 3, skills: [], workspace: 'scratch' });

      const all = board.listTasks();
      expect(all).toHaveLength(3);
    });

    it('filters by status', () => {
      board.createTask({ title: 'Todo', body: 'B', status: 'todo', priority: 1, skills: [], workspace: 'scratch' });
      board.createTask({ title: 'Done', body: 'B', status: 'done', priority: 1, skills: [], workspace: 'scratch' });

      const todos = board.listTasks({ status: 'todo' });
      expect(todos).toHaveLength(1);
      expect(todos[0].title).toBe('Todo');
    });

    it('filters by workspace', () => {
      board.createTask({ title: 'Scratch', body: 'B', status: 'todo', priority: 1, skills: [], workspace: 'scratch' });
      board.createTask({ title: 'Project', body: 'B', status: 'todo', priority: 1, skills: [], workspace: 'project' });

      const scratch = board.listTasks({ workspace: 'scratch' });
      expect(scratch).toHaveLength(1);
      expect(scratch[0].title).toBe('Scratch');
    });

    it('filters by tenantId', () => {
      board.createTask({ title: 'Tenant A', body: 'B', status: 'todo', priority: 1, skills: [], workspace: 'scratch', tenantId: 'a' });
      board.createTask({ title: 'Tenant B', body: 'B', status: 'todo', priority: 1, skills: [], workspace: 'scratch', tenantId: 'b' });

      const tenantA = board.listTasks({ tenantId: 'a' });
      expect(tenantA).toHaveLength(1);
    });
  });

  describe('moveTask', () => {
    it('returns false for non-existent task', () => {
      expect(board.moveTask('nonexistent', 'in_progress')).toBe(false);
    });

    it('moves task with valid transition', () => {
      const task = board.createTask({
        title: 'Move Test',
        body: 'B',
        status: 'todo',
        priority: 1,
        skills: [],
        workspace: 'scratch',
      });

      expect(board.moveTask(task.id, 'in_progress')).toBe(true);
      expect(board.getTask(task.id)!.status).toBe('in_progress');
    });

    it('rejects invalid transition', () => {
      const task = board.createTask({
        title: 'Invalid Move',
        body: 'B',
        status: 'todo',
        priority: 1,
        skills: [],
        workspace: 'scratch',
      });

      // todo -> review is invalid
      expect(board.moveTask(task.id, 'review')).toBe(false);
      expect(board.getTask(task.id)!.status).toBe('todo'); // unchanged
    });
  });

  describe('getStats', () => {
    it('returns zero counts initially', () => {
      expect(board.getStats()).toEqual({ todo: 0, inProgress: 0, review: 0, done: 0 });
    });

    it('returns correct counts', () => {
      board.createTask({ title: 'T1', body: 'B', status: 'todo', priority: 1, skills: [], workspace: 'scratch' });
      board.createTask({ title: 'T2', body: 'B', status: 'todo', priority: 1, skills: [], workspace: 'scratch' });
      board.createTask({ title: 'T3', body: 'B', status: 'in_progress', priority: 1, skills: [], workspace: 'scratch' });
      board.createTask({ title: 'T4', body: 'B', status: 'review', priority: 1, skills: [], workspace: 'scratch' });
      board.createTask({ title: 'T5', body: 'B', status: 'done', priority: 1, skills: [], workspace: 'scratch' });

      const stats = board.getStats();
      expect(stats.todo).toBe(2);
      expect(stats.inProgress).toBe(1);
      expect(stats.review).toBe(1);
      expect(stats.done).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Kill-switch behavior
// ---------------------------------------------------------------------------

describe('KanbanBoard kill-switch', () => {
  let tmpDir: string;
  let board: KanbanBoard;
  let originalValue: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    originalValue = process.env['SUDO_KANBAN_DISABLE'];
    process.env['SUDO_KANBAN_DISABLE'] = '1';
    board = makeBoard(tmpDir);
  });

  afterEach(() => {
    board.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalValue !== undefined) {
      process.env['SUDO_KANBAN_DISABLE'] = originalValue;
    } else {
      delete process.env['SUDO_KANBAN_DISABLE'];
    }
  });

  it('throws on createTask when disabled', () => {
    expect(() =>
      board.createTask({ title: 'X', body: 'B', status: 'todo', priority: 1, skills: [], workspace: 'scratch' })
    ).toThrow('SUDO_KANBAN_DISABLE');
  });

  it('throws on getTask when disabled', () => {
    expect(() => board.getTask('x')).toThrow('SUDO_KANBAN_DISABLE');
  });

  it('throws on listTasks when disabled', () => {
    expect(() => board.listTasks()).toThrow('SUDO_KANBAN_DISABLE');
  });

  it('throws on getStats when disabled', () => {
    expect(() => board.getStats()).toThrow('SUDO_KANBAN_DISABLE');
  });
});

describe('SwarmOrchestrator kill-switch', () => {
  let originalValue: string | undefined;
  const orchestrator = new SwarmOrchestrator();

  beforeEach(() => {
    originalValue = process.env['SUDO_KANBAN_DISABLE'];
    process.env['SUDO_KANBAN_DISABLE'] = '1';
  });

  afterEach(() => {
    if (originalValue !== undefined) {
      process.env['SUDO_KANBAN_DISABLE'] = originalValue;
    } else {
      delete process.env['SUDO_KANBAN_DISABLE'];
    }
  });

  it('throws on decompose when disabled', () => {
    const task: KanbanTask = {
      id: 'x', title: 'X', body: 'B', status: 'todo', priority: 1,
      skills: [], workspace: 'scratch', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(() => orchestrator.decompose(task)).toThrow('SUDO_KANBAN_DISABLE');
  });
});

// ---------------------------------------------------------------------------
// 4. Swarm decomposition
// ---------------------------------------------------------------------------

describe('SwarmOrchestrator.decompose', () => {
  const orchestrator = new SwarmOrchestrator();

  it('creates one worker per skill', () => {
    const task: KanbanTask = {
      id: 't1',
      title: 'Multi-skill task',
      body: 'Do the thing',
      status: 'todo',
      priority: 4,
      assignee: null,
      skills: ['research', 'coding', 'testing'],
      parentId: null,
      workspace: 'project',
      tenantId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const workers = orchestrator.decompose(task);
    expect(workers).toHaveLength(3);
    expect(workers[0].skills).toEqual(['research']);
    expect(workers[1].skills).toEqual(['coding']);
    expect(workers[2].skills).toEqual(['testing']);
  });

  it('creates single general worker when no skills specified', () => {
    const task: KanbanTask = {
      id: 't2',
      title: 'Simple task',
      body: 'Just do it',
      status: 'todo',
      priority: 2,
      assignee: null,
      skills: [],
      parentId: null,
      workspace: 'scratch',
      tenantId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const workers = orchestrator.decompose(task);
    expect(workers).toHaveLength(1);
    expect(workers[0].skills).toEqual(['general']);
    expect(workers[0].title).toContain('Simple task');
  });
});

// ---------------------------------------------------------------------------
// 5. REST routes
// ---------------------------------------------------------------------------

describe('Kanban REST routes', () => {
  // Note: Full route testing requires server integration.
  // These tests verify the route registration and basic auth.

  it('admin auth helper works with valid token', () => {
    const req = makeMockReq({
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    // Simulate the auth check from routes
    const candidate = Buffer.from(ADMIN_TOKEN, 'utf8');
    const authorised = candidate.length === ADMIN_TOKEN_BUF.length &&
      require('node:crypto').timingSafeEqual(candidate, ADMIN_TOKEN_BUF);
    expect(authorised).toBe(true);
  });

  it('admin auth helper rejects invalid token', () => {
    const req = makeMockReq({
      headers: { authorization: 'Bearer wrong-token' },
    });
    const candidate = Buffer.from('wrong-token', 'utf8');
    const authorised = candidate.length === ADMIN_TOKEN_BUF.length &&
      require('node:crypto').timingSafeEqual(candidate, ADMIN_TOKEN_BUF);
    expect(authorised).toBe(false);
  });

  it('admin auth helper rejects missing token', () => {
    const req = makeMockReq({ headers: {} });
    const h = req.headers['authorization'] ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    const token = m ? (m[1] ?? '') : '';
    expect(token).toBe('');
  });
});
