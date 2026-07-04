/**
 * Tests for coder.todo — the model-callable plan/todo checklist tool.
 *
 * Covers: add (array + single string + empty), start/complete/fail transitions,
 * id validation, per-session tracker isolation, list, and clear.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { todoTool, _resetTodoTracker } from '../../src/core/tools/builtin/coder/todo.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// Minimal ToolContext stub — todo only reads ctx.sessionId.
function ctx(sessionId: string): ToolContext {
  return { sessionId } as unknown as ToolContext;
}

const SESSION = 'test-session-todo';

beforeEach(() => {
  _resetTodoTracker(SESSION);
  _resetTodoTracker('other-session');
});

describe('coder.todo', () => {
  it('adds multiple todos from a subjects array', async () => {
    const res = await todoTool.execute(
      { action: 'add', subjects: ['step one', 'step two', 'step three'] },
      ctx(SESSION),
    );
    expect(res.success).toBe(true);
    const tasks = (res.data as { tasks: Array<{ subject: string; status: string }> }).tasks;
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.subject)).toEqual(['step one', 'step two', 'step three']);
    expect(tasks.every((t) => t.status === 'pending')).toBe(true);
    expect(res.output).toContain('0/3 tasks completed');
  });

  it('accepts a single string subject', async () => {
    const res = await todoTool.execute({ action: 'add', subjects: 'lonely task' }, ctx(SESSION));
    expect(res.success).toBe(true);
    const tasks = (res.data as { tasks: unknown[] }).tasks;
    expect(tasks).toHaveLength(1);
  });

  it('rejects add with no valid subjects', async () => {
    const res = await todoTool.execute({ action: 'add', subjects: ['', '  '] }, ctx(SESSION));
    expect(res.success).toBe(false);
    expect(res.output).toContain('non-empty array');
  });

  it('transitions start -> complete and reflects progress', async () => {
    const add = await todoTool.execute({ action: 'add', subjects: ['do a thing'] }, ctx(SESSION));
    const id = (add.data as { added: Array<{ id: string }> }).added[0].id;

    const started = await todoTool.execute({ action: 'start', id }, ctx(SESSION));
    expect(started.success).toBe(true);
    expect((started.data as { task: { status: string } }).task.status).toBe('in_progress');

    const done = await todoTool.execute({ action: 'complete', id }, ctx(SESSION));
    expect(done.success).toBe(true);
    expect((done.data as { task: { status: string } }).task.status).toBe('completed');
    expect(done.output).toContain('1/1 tasks completed');
  });

  it('marks a todo failed with an error message', async () => {
    const add = await todoTool.execute({ action: 'add', subjects: ['risky task'] }, ctx(SESSION));
    const id = (add.data as { added: Array<{ id: string }> }).added[0].id;

    const failed = await todoTool.execute(
      { action: 'fail', id, error: 'boom' },
      ctx(SESSION),
    );
    expect(failed.success).toBe(true);
    const task = (failed.data as { task: { status: string; error: string } }).task;
    expect(task.status).toBe('failed');
    expect(task.error).toBe('boom');
    expect(failed.output).toContain('boom');
    expect(failed.output).toContain('(1 failed)');
  });

  it('requires an id for start/complete/fail', async () => {
    const res = await todoTool.execute({ action: 'start' }, ctx(SESSION));
    expect(res.success).toBe(false);
    expect(res.output).toContain('"id" is required');
  });

  it('reports an unknown id without throwing', async () => {
    const res = await todoTool.execute({ action: 'complete', id: 'task-does-not-exist' }, ctx(SESSION));
    expect(res.success).toBe(false);
    expect(res.output).toContain('no todo with id');
  });

  it('isolates plans between sessions', async () => {
    await todoTool.execute({ action: 'add', subjects: ['session A task'] }, ctx(SESSION));
    const otherList = await todoTool.execute({ action: 'list' }, ctx('other-session'));
    expect((otherList.data as { tasks: unknown[] }).tasks).toHaveLength(0);
  });

  it('clears the plan', async () => {
    await todoTool.execute({ action: 'add', subjects: ['a', 'b'] }, ctx(SESSION));
    const cleared = await todoTool.execute({ action: 'clear' }, ctx(SESSION));
    expect(cleared.success).toBe(true);
    const list = await todoTool.execute({ action: 'list' }, ctx(SESSION));
    expect((list.data as { tasks: unknown[] }).tasks).toHaveLength(0);
  });

  it('rejects an unknown action', async () => {
    const res = await todoTool.execute({ action: 'frobnicate' }, ctx(SESSION));
    expect(res.success).toBe(false);
    expect(res.output).toContain('unknown action');
  });
});
