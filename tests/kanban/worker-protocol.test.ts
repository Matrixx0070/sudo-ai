/**
 * @file worker-protocol.test.ts
 * @description Unit tests for WorkerProtocolManager — registration, heartbeat,
 *              completion, blocking, circuit breaker lifecycle, availability, stats.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerProtocolManager } from '../../src/core/kanban/worker-protocol.js';
import type {
  WorkerHeartbeat,
  WorkerCompletion,
  WorkerBlock,
} from '../../src/core/kanban/worker-protocol.js';

// ---------------------------------------------------------------------------
// Mock dispatcher
// ---------------------------------------------------------------------------

function mockDispatcher() {
  return { tick: vi.fn(), assign: vi.fn(), reclaim: vi.fn() } as any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function heartbeat(workerId: string, taskId: string): WorkerHeartbeat {
  return {
    workerId,
    taskId,
    progress: 0.5,
    timestamp: new Date().toISOString(),
  };
}

function completion(workerId: string, taskId: string, success: boolean): WorkerCompletion {
  return {
    workerId,
    taskId,
    result: success ? 'done' : 'error',
    durationMs: 1000,
    success,
  };
}

function blockSignal(workerId: string, taskId: string, reason: string): WorkerBlock {
  return {
    workerId,
    taskId,
    reason,
    requiresHumanAttention: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerProtocolManager', () => {
  let mgr: WorkerProtocolManager;
  let dispatcher: ReturnType<typeof mockDispatcher>;

  beforeEach(() => {
    vi.useFakeTimers();
    dispatcher = mockDispatcher();
    mgr = new WorkerProtocolManager(dispatcher, {
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 1000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -- Registration ---------------------------------------------------------

  describe('register / unregister', () => {
    it('registers a worker and initializes its circuit breaker', () => {
      mgr.registerWorker('w1', ['code', 'test']);
      const breaker = mgr.getCircuitBreaker('w1');
      expect(breaker).toBeDefined();
      expect(breaker!.state).toBe('closed');
      expect(breaker!.failureCount).toBe(0);
    });

    it('unregisters a worker and clears its breaker', () => {
      mgr.registerWorker('w1', ['code']);
      mgr.unregisterWorker('w1');
      expect(mgr.getCircuitBreaker('w1')).toBeUndefined();
      expect(mgr.isWorkerAvailable('w1')).toBe(false);
    });
  });

  // -- Heartbeat ------------------------------------------------------------

  describe('heartbeat', () => {
    it('updates last-seen timestamp on heartbeat', () => {
      mgr.registerWorker('w1', ['code']);
      const before = mgr.getCircuitBreaker('w1')!;
      mgr.heartbeat(heartbeat('w1', 't1'));
      const stats = mgr.getStats();
      expect(stats.totalHeartbeats).toBe(1);
    });

    it('ignores heartbeat from unknown worker', () => {
      mgr.heartbeat(heartbeat('ghost', 't1'));
      expect(mgr.getStats().totalHeartbeats).toBe(0);
    });
  });

  // -- Completion -----------------------------------------------------------

  describe('complete', () => {
    it('records success and resets failure count', () => {
      mgr.registerWorker('w1', ['code']);
      mgr.complete(completion('w1', 't1', true));
      expect(mgr.getCircuitBreaker('w1')!.failureCount).toBe(0);
      expect(mgr.getStats().totalCompletions).toBe(1);
    });

    it('increments failure count on failure', () => {
      mgr.registerWorker('w1', ['code']);
      mgr.complete(completion('w1', 't1', false));
      expect(mgr.getCircuitBreaker('w1')!.failureCount).toBe(1);
    });

    it('ignores completion from unknown worker', () => {
      mgr.complete(completion('ghost', 't1', true));
      expect(mgr.getStats().totalCompletions).toBe(0);
    });
  });

  // -- Block ----------------------------------------------------------------

  describe('block', () => {
    it('records block reason and frees the worker', () => {
      mgr.registerWorker('w1', ['code']);
      mgr.heartbeat(heartbeat('w1', 't1'));
      mgr.block(blockSignal('w1', 't1', 'missing dependency'));
      expect(mgr.getStats().totalBlocks).toBe(1);
      // Block does not count as a breaker failure
      expect(mgr.getCircuitBreaker('w1')!.failureCount).toBe(0);
      expect(mgr.getCircuitBreaker('w1')!.state).toBe('closed');
    });

    it('ignores block from unknown worker', () => {
      mgr.block(blockSignal('ghost', 't1', 'reason'));
      expect(mgr.getStats().totalBlocks).toBe(0);
    });
  });

  // -- Circuit breaker lifecycle --------------------------------------------

  describe('circuit breaker', () => {
    it('opens after threshold consecutive failures', () => {
      mgr.registerWorker('w1', ['code']);
      for (let i = 0; i < 3; i++) {
        mgr.complete(completion('w1', `t${i}`, false));
      }
      const breaker = mgr.getCircuitBreaker('w1')!;
      expect(breaker.state).toBe('open');
      expect(breaker.failureCount).toBe(3);
      expect(mgr.getStats().circuitBreakerTrips).toBe(1);
    });

    it('transitions to half-open after cooldown elapses', () => {
      mgr.registerWorker('w1', ['code']);
      for (let i = 0; i < 3; i++) {
        mgr.complete(completion('w1', `t${i}`, false));
      }
      expect(mgr.getCircuitBreaker('w1')!.state).toBe('open');

      // Advance past cooldown; transition is lazy — triggered by isWorkerAvailable
      vi.advanceTimersByTime(1001);
      expect(mgr.isWorkerAvailable('w1')).toBe(true);
      expect(mgr.getCircuitBreaker('w1')!.state).toBe('half-open');
    });

    it('closes after success in half-open state', () => {
      mgr.registerWorker('w1', ['code']);
      for (let i = 0; i < 3; i++) {
        mgr.complete(completion('w1', `t${i}`, false));
      }

      // Advance past cooldown → half-open
      vi.advanceTimersByTime(1001);
      mgr.isWorkerAvailable('w1'); // trigger lazy transition
      expect(mgr.getCircuitBreaker('w1')!.state).toBe('half-open');

      // Successful completion closes the breaker
      mgr.complete(completion('w1', 't-recover', true));
      expect(mgr.getCircuitBreaker('w1')!.state).toBe('closed');
      expect(mgr.getCircuitBreaker('w1')!.failureCount).toBe(0);
    });

    it('re-opens on failure in half-open state', () => {
      mgr.registerWorker('w1', ['code']);
      for (let i = 0; i < 3; i++) {
        mgr.complete(completion('w1', `t${i}`, false));
      }

      // Advance past cooldown → half-open
      vi.advanceTimersByTime(1001);
      mgr.isWorkerAvailable('w1'); // trigger lazy transition
      expect(mgr.getCircuitBreaker('w1')!.state).toBe('half-open');

      mgr.complete(completion('w1', 't-fail-again', false));
      expect(mgr.getCircuitBreaker('w1')!.state).toBe('open');
      expect(mgr.getStats().circuitBreakerTrips).toBe(2);
    });
  });

  // -- Available workers ---------------------------------------------------

  describe('available workers', () => {
    it('excludes circuit-broken (open) workers', () => {
      mgr.registerWorker('w1', ['code']);
      mgr.registerWorker('w2', ['code']);
      for (let i = 0; i < 3; i++) {
        mgr.complete(completion('w1', `t${i}`, false));
      }
      const available = mgr.getAvailableWorkers();
      expect(available).not.toContain('w1');
      expect(available).toContain('w2');
    });

    it('excludes workers currently assigned a task', () => {
      mgr.registerWorker('w1', ['code']);
      mgr.heartbeat(heartbeat('w1', 't-active'));
      expect(mgr.isWorkerAvailable('w1')).toBe(false);
    });
  });

  // -- Stats ----------------------------------------------------------------

  describe('stats', () => {
    it('tracks cumulative stats across operations', () => {
      mgr.registerWorker('w1', ['code']);
      mgr.heartbeat(heartbeat('w1', 't1'));
      mgr.complete(completion('w1', 't1', true));
      mgr.block(blockSignal('w1', 't2', 'blocked'));

      const stats = mgr.getStats();
      expect(stats.totalHeartbeats).toBe(1);
      expect(stats.totalCompletions).toBe(1);
      expect(stats.totalBlocks).toBe(1);
      expect(stats.circuitBreakerTrips).toBe(0);
    });
  });
});