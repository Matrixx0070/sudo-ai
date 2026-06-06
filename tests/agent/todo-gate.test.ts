/**
 * @file todo-gate.test.ts
 * @description Tests for TodoGate.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TodoGate, TODO_GATE_ENABLED, TODO_GATE_MAX_RETRIES } from '../../src/core/agent/todo-gate.js';

describe('TodoGate', () => {
  let gate: TodoGate;

  beforeEach(() => {
    gate = new TodoGate(null);
  });

  it('should pass when no todos exist', () => {
    const result = gate.check();
    expect(result.action).toBe('pass');
    expect(result.incompleteCount).toBe(0);
  });

  it('should pass when all todos are completed', () => {
    gate.addTodo('t1', 'Task 1', 'high');
    gate.addTodo('t2', 'Task 2', 'medium');
    gate.completeTodo('t1');
    gate.completeTodo('t2');
    const result = gate.check();
    expect(result.action).toBe('pass');
    expect(result.incompleteCount).toBe(0);
  });

  it('should block when todos are incomplete (if enabled)', () => {
    // Force enable for testing
    const original = process.env['SUDO_TODO_GATE'];
    process.env['SUDO_TODO_GATE'] = '1';

    try {
      const testGate = new TodoGate(null);
      testGate.addTodo('t1', 'Fix the bug', 'high');
      testGate.addTodo('t2', 'Write tests', 'medium');
      testGate.completeTodo('t2');

      const result = testGate.check();
      expect(result.action).toBe('block');
      expect(result.incompleteCount).toBe(1);
      expect(result.reason).toContain('Fix the bug');
      expect(result.totalCount).toBe(2);
    } finally {
      if (original !== undefined) {
        process.env['SUDO_TODO_GATE'] = original;
      } else {
        delete process.env['SUDO_TODO_GATE'];
      }
    }
  });

  it('should emit telemetry events via hooks', () => {
    const orig = process.env['SUDO_TODO_GATE'];
    process.env['SUDO_TODO_GATE'] = '1';
    try {
      const mockHooks = { emit: vi.fn() };
      const testGate = new TodoGate(mockHooks);
      testGate.addTodo('t1', 'Task', 'high');

      testGate.check();

      expect(mockHooks.emit).toHaveBeenCalledWith('todo_gate_fired', expect.objectContaining({
        event: 'todo_gate_fired',
      }));
    } finally {
      if (orig !== undefined) process.env['SUDO_TODO_GATE'] = orig;
      else delete process.env['SUDO_TODO_GATE'];
    }
  });

  it('should allow stopping after max retries exhausted', () => {
    const orig = process.env['SUDO_TODO_GATE'];
    process.env['SUDO_TODO_GATE'] = '1';
    try {
      const testGate = new TodoGate(null);
      testGate.addTodo('t1', 'Impossible task', 'critical');

      // Exhaust retries
      for (let i = 0; i <= TODO_GATE_MAX_RETRIES + 1; i++) {
        testGate.check();
      }

      const result = testGate.check();
      expect(result.action).toBe('pass');
      expect(result.reason).toContain('exhausted');
    } finally {
      if (orig !== undefined) process.env['SUDO_TODO_GATE'] = orig;
      else delete process.env['SUDO_TODO_GATE'];
    }
  });

  it('should sort incomplete todos by priority', () => {
    const orig = process.env['SUDO_TODO_GATE'];
    process.env['SUDO_TODO_GATE'] = '1';
    try {
      const testGate = new TodoGate(null);
      testGate.addTodo('t1', 'Low priority task', 'low');
      testGate.addTodo('t2', 'Critical task', 'critical');
      testGate.addTodo('t3', 'Medium task', 'medium');

      const result = testGate.check();
      expect(result.action).toBe('block');
      // Critical should appear first in the reason
      expect(result.reason?.indexOf('Critical task')).toBeLessThan(result.reason?.indexOf('Low priority task') ?? 0);
    } finally {
      if (orig !== undefined) process.env['SUDO_TODO_GATE'] = orig;
      else delete process.env['SUDO_TODO_GATE'];
    }
  });

  it('should support uncompleteTodo', () => {
    gate.addTodo('t1', 'Task', 'high');
    gate.completeTodo('t1');
    expect(gate.getIncompleteTodos().length).toBe(0);

    gate.uncompleteTodo('t1');
    expect(gate.getIncompleteTodos().length).toBe(1);
  });

  it('should support removeTodo', () => {
    gate.addTodo('t1', 'Task 1', 'high');
    gate.addTodo('t2', 'Task 2', 'medium');
    gate.removeTodo('t1');
    expect(gate.getTodos().length).toBe(1);
  });

  it('should support clearTodos', () => {
    gate.addTodo('t1', 'Task 1', 'high');
    gate.addTodo('t2', 'Task 2', 'medium');
    gate.clearTodos();
    expect(gate.getTodos().length).toBe(0);
  });

  it('should reset retries', () => {
    gate.resetRetries();
    expect(gate.retryCountValue).toBe(0);
  });
});