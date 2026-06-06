/**
 * @file todo-gate.ts
 * @description TodoGate — runtime turn-end gate that checks whether todos are
 * completed before the agent can stop. Grok Build CLI parity.
 *
 * When the agent tries to finish a turn, TodoGate intercepts and checks:
 *   - Are there incomplete todos?
 *   - Are there pending tasks in the plan?
 *   - Is there unfinished work that should be continued?
 *
 * If todos remain, the agent is forced to continue working.
 * Emits telemetry: todo_gate_fired, todo_gate_exhausted.
 *
 * Enabled via --todo-gate CLI flag or SUDO_TODO_GATE=1 env var.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:todo-gate');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Whether TodoGate is enabled (from env or CLI flag). Checked at runtime. */
export function isTodoGateEnabled(): boolean {
  return process.env['SUDO_TODO_GATE'] === '1' || process.env['SUDO_TODO_GATE'] === 'true';
}

/** Module-level constant for backward compat. */
export const TODO_GATE_ENABLED: boolean = isTodoGateEnabled();

/** Maximum number of times TodoGate forces continuation before giving up. */
export const TODO_GATE_MAX_RETRIES: number =
  Number(process.env['SUDO_TODO_GATE_MAX_RETRIES']) || 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TodoItem = {
  /** Unique ID for this todo item. */
  id: string;
  /** Description of what needs to be done. */
  description: string;
  /** Whether this todo is completed. */
  completed: boolean;
  /** Priority level. */
  priority: 'low' | 'medium' | 'high' | 'critical';
};

export type TodoGateResult = {
  /** 'pass' = all todos complete, agent can stop. 'block' = incomplete todos, must continue. */
  action: 'pass' | 'block';
  /** Human-readable reason. */
  reason?: string;
  /** Number of incomplete todos. */
  incompleteCount: number;
  /** Total number of todos. */
  totalCount: number;
};

export interface TodoGateEvent {
  event: 'todo_gate_fired' | 'todo_gate_exhausted';
  incompleteCount: number;
  totalCount: number;
  retryCount: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// TodoGate
// ---------------------------------------------------------------------------

/**
 * Turn-end completion gate that prevents the agent from stopping when
 * there are incomplete todos.
 *
 * Usage:
 * ```ts
 * const gate = new TodoGate(hooks);
 * gate.addTodo('fix-login', 'Fix the login bug', 'high');
 * // ... agent works ...
 * gate.completeTodo('fix-login');
 * const result = gate.check();
 * // result.action = 'pass' if all complete, 'block' if any remain
 * ```
 */
export class TodoGate {
  private readonly todos = new Map<string, TodoItem>();
  private retryCount = 0;
  private readonly hooks?: { emit(event: string, data: Record<string, unknown>): void } | null;

  constructor(hooks?: { emit(event: string, data: Record<string, unknown>): void } | null) {
    this.hooks = hooks ?? null;
    log.info({ enabled: TODO_GATE_ENABLED }, 'TodoGate initialised');
  }

  // -------------------------------------------------------------------------
  // Todo management
  // -------------------------------------------------------------------------

  /** Add a todo item. */
  addTodo(id: string, description: string, priority: TodoItem['priority'] = 'medium'): void {
    this.todos.set(id, { id, description, completed: false, priority });
    log.debug({ id, description, priority }, 'Todo added');
  }

  /** Mark a todo as completed. */
  completeTodo(id: string): void {
    const todo = this.todos.get(id);
    if (todo) {
      todo.completed = true;
      log.debug({ id }, 'Todo completed');
    }
  }

  /** Mark a todo as incomplete (e.g., after reverting). */
  uncompleteTodo(id: string): void {
    const todo = this.todos.get(id);
    if (todo) {
      todo.completed = false;
      log.debug({ id }, 'Todo uncompleted');
    }
  }

  /** Remove a todo item. */
  removeTodo(id: string): void {
    this.todos.delete(id);
  }

  /** Clear all todos. */
  clearTodos(): void {
    this.todos.clear();
    this.retryCount = 0;
  }

  /** Get all todo items. */
  getTodos(): TodoItem[] {
    return Array.from(this.todos.values());
  }

  /** Get incomplete todos. */
  getIncompleteTodos(): TodoItem[] {
    return Array.from(this.todos.values()).filter(t => !t.completed);
  }

  // -------------------------------------------------------------------------
  // Gate check
  // -------------------------------------------------------------------------

  /**
   * Check if the agent can stop (all todos complete).
   * Returns 'block' if there are incomplete todos and retries remain.
   * Returns 'pass' if all todos are complete or retries are exhausted.
   */
  check(): TodoGateResult {
    if (!isTodoGateEnabled()) {
      return { action: 'pass', incompleteCount: 0, totalCount: this.todos.size };
    }

    const incomplete = this.getIncompleteTodos();
    const incompleteCount = incomplete.length;
    const totalCount = this.todos.size;

    // No todos = pass
    if (totalCount === 0) {
      return { action: 'pass', incompleteCount: 0, totalCount: 0 };
    }

    // All complete = pass
    if (incompleteCount === 0) {
      this.retryCount = 0;
      return { action: 'pass', incompleteCount: 0, totalCount };
    }

    // Increment retry count
    this.retryCount++;

    // Check if retries exhausted
    if (this.retryCount > TODO_GATE_MAX_RETRIES) {
      const event: TodoGateEvent = {
        event: 'todo_gate_exhausted',
        incompleteCount,
        totalCount,
        retryCount: this.retryCount,
        timestamp: new Date().toISOString(),
      };
      this._emitTelemetry(event);

      log.warn(
        { incompleteCount, totalCount, retries: this.retryCount },
        'TodoGate retries exhausted — allowing agent to stop',
      );

      return {
        action: 'pass',
        reason: `TodoGate exhausted after ${TODO_GATE_MAX_RETRIES} retries — ${incompleteCount} todos still incomplete but allowing stop to prevent infinite loop`,
        incompleteCount,
        totalCount,
      };
    }

    // Block — force continuation
    const event: TodoGateEvent = {
      event: 'todo_gate_fired',
      incompleteCount,
      totalCount,
      retryCount: this.retryCount,
      timestamp: new Date().toISOString(),
    };
    this._emitTelemetry(event);

    const incompleteDescs = incomplete
      .sort((a, b) => {
        const prioOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return (prioOrder[a.priority] ?? 2) - (prioOrder[b.priority] ?? 2);
      })
      .map(t => `  - [${t.priority}] ${t.description}`)
      .join('\n');

    log.info(
      { incompleteCount, totalCount, retry: this.retryCount },
      'TodoGate blocking — incomplete todos remain',
    );

    return {
      action: 'block',
      reason: `TodoGate: ${incompleteCount} incomplete todo(s) remain. Continue working on:\n${incompleteDescs}`,
      incompleteCount,
      totalCount,
    };
  }

  /** Reset retry counter (e.g., at the start of a new turn). */
  resetRetries(): void {
    this.retryCount = 0;
  }

  /** Current retry count. */
  get retryCountValue(): number {
    return this.retryCount;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _emitTelemetry(event: TodoGateEvent): void {
    if (this.hooks && typeof this.hooks.emit === 'function') {
      try {
        this.hooks.emit(event.event, event as unknown as Record<string, unknown>);
      } catch (err) {
        log.error({ err }, 'Failed to emit TodoGate telemetry');
      }
    }
  }
}