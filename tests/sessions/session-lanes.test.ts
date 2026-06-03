/**
 * @file session-lanes.test.ts
 * @description Tests for SessionLaneManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionLaneManager, resetLaneManager } from '../../src/core/sessions/session-lanes.js';

describe('SessionLaneManager', () => {
  let manager: SessionLaneManager;

  beforeEach(() => {
    // Clear any previous kill-switch setting
    delete process.env.SUDO_SESSION_LANES_DISABLE;
    resetLaneManager();
    manager = new SessionLaneManager();
  });

  afterEach(() => {
    delete process.env.SUDO_SESSION_LANES_DISABLE;
    resetLaneManager();
  });

  describe('enqueue - parallel execution across lane types', () => {
    it('should execute tasks in different lane types in parallel', async () => {
      const executionOrder: string[] = [];
      const delays = [50, 50, 50, 50];

      const promises = [
        manager.enqueue('default', 'key1', async () => {
          await new Promise((r) => setTimeout(r, delays[0]));
          executionOrder.push('default:key1');
        }),
        manager.enqueue('nested', 'key1', async () => {
          await new Promise((r) => setTimeout(r, delays[1]));
          executionOrder.push('nested:key1');
        }),
        manager.enqueue('subagent', 'key1', async () => {
          await new Promise((r) => setTimeout(r, delays[2]));
          executionOrder.push('subagent:key1');
        }),
        manager.enqueue('cron', 'key1', async () => {
          await new Promise((r) => setTimeout(r, delays[3]));
          executionOrder.push('cron:key1');
        }),
      ];

      await Promise.all(promises);

      // All should have started in parallel (within 100ms window)
      expect(executionOrder).toHaveLength(4);
      // All different lane types should be present
      expect(executionOrder).toContain('default:key1');
      expect(executionOrder).toContain('nested:key1');
      expect(executionOrder).toContain('subagent:key1');
      expect(executionOrder).toContain('cron:key1');
    });

    it('should execute tasks with different keys in same lane type in parallel', async () => {
      const executionOrder: string[] = [];
      const startTime = Date.now();

      const promises = [
        manager.enqueue('default', 'key1', async () => {
          await new Promise((r) => setTimeout(r, 50));
          executionOrder.push('key1');
        }),
        manager.enqueue('default', 'key2', async () => {
          await new Promise((r) => setTimeout(r, 50));
          executionOrder.push('key2');
        }),
        manager.enqueue('default', 'key3', async () => {
          await new Promise((r) => setTimeout(r, 50));
          executionOrder.push('key3');
        }),
      ];

      await Promise.all(promises);
      const elapsed = Date.now() - startTime;

      // Should complete in ~50ms if truly parallel, ~150ms if serialized
      expect(elapsed).toBeLessThan(100);
      expect(executionOrder).toHaveLength(3);
    });
  });

  describe('enqueue - serialization within same lane type', () => {
    it('should serialize tasks with same lane type and same key', async () => {
      const executionOrder: string[] = [];

      const promises = [
        manager.enqueue('default', 'key1', async () => {
          await new Promise((r) => setTimeout(r, 30));
          executionOrder.push('task1');
          return 1;
        }),
        manager.enqueue('default', 'key1', async () => {
          await new Promise((r) => setTimeout(r, 30));
          executionOrder.push('task2');
          return 2;
        }),
        manager.enqueue('default', 'key1', async () => {
          await new Promise((r) => setTimeout(r, 30));
          executionOrder.push('task3');
          return 3;
        }),
      ];

      const results = await Promise.all(promises);

      // Tasks should execute in order
      expect(executionOrder).toEqual(['task1', 'task2', 'task3']);
      expect(results).toEqual([1, 2, 3]);
    });

    it('should maintain order for same key even when enqueued out of order', async () => {
      const results: number[] = [];

      const p1 = manager.enqueue('subagent', 'session-1', async () => {
        await new Promise((r) => setTimeout(r, 20));
        results.push(1);
        return 1;
      });

      const p2 = manager.enqueue('subagent', 'session-1', async () => {
        await new Promise((r) => setTimeout(r, 20));
        results.push(2);
        return 2;
      });

      const p3 = manager.enqueue('subagent', 'session-1', async () => {
        await new Promise((r) => setTimeout(r, 20));
        results.push(3);
        return 3;
      });

      await Promise.all([p1, p2, p3]);

      expect(results).toEqual([1, 2, 3]);
    });
  });

  describe('getActiveCount', () => {
    it('should return total active count when no laneType specified', async () => {
      const longTask = new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });

      manager.enqueue('default', 'key1', () => longTask);
      manager.enqueue('nested', 'key2', () => longTask);
      manager.enqueue('subagent', 'key3', () => longTask);

      // Give time for tasks to start
      await new Promise((r) => setTimeout(r, 10));

      const count = manager.getActiveCount();
      expect(count).toBe(3);

      await Promise.allSettled([
        manager.enqueue('default', 'key1', async () => {}),
        manager.enqueue('nested', 'key2', async () => {}),
        manager.enqueue('subagent', 'key3', async () => {}),
      ]);
    });

    it('should filter active count by lane type', async () => {
      const longTask = new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });

      manager.enqueue('default', 'key1', () => longTask);
      manager.enqueue('default', 'key2', () => longTask);
      manager.enqueue('nested', 'key3', () => longTask);
      manager.enqueue('subagent', 'key4', () => longTask);

      await new Promise((r) => setTimeout(r, 10));

      expect(manager.getActiveCount('default')).toBe(2);
      expect(manager.getActiveCount('nested')).toBe(1);
      expect(manager.getActiveCount('subagent')).toBe(1);
      expect(manager.getActiveCount('cron')).toBe(0);
    });

    it('should return 0 when no tasks are active', () => {
      expect(manager.getActiveCount()).toBe(0);
      expect(manager.getActiveCount('default')).toBe(0);
    });
  });

  describe('getQueueDepth', () => {
    it('should return queue depth for a lane key', async () => {
      // First, enqueue a long-running task
      let resolveTask: (() => void) | undefined;
      const longTask = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      manager.enqueue('default', 'key1', () => longTask);

      // Enqueue more tasks behind it
      manager.enqueue('default', 'key1', async () => {});
      manager.enqueue('default', 'key1', async () => {});
      manager.enqueue('default', 'key1', async () => {});

      await new Promise((r) => setTimeout(r, 10));

      const depth = manager.getQueueDepth('key1');
      expect(depth).toBeGreaterThanOrEqual(1);

      // Release the first task
      if (resolveTask) resolveTask();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('should return 0 for unknown lane key', () => {
      expect(manager.getQueueDepth('unknown-key')).toBe(0);
    });

    it('should sum depths across all lane types for same key', async () => {
      const longTask = new Promise<void>((resolve) => setTimeout(resolve, 200));

      manager.enqueue('default', 'shared-key', () => longTask);
      manager.enqueue('nested', 'shared-key', () => longTask);
      manager.enqueue('default', 'shared-key', async () => {});

      await new Promise((r) => setTimeout(r, 10));

      const depth = manager.getQueueDepth('shared-key');
      expect(depth).toBeGreaterThanOrEqual(2);
    });
  });

  describe('drain', () => {
    it('should drain tasks for a specific lane key', async () => {
      manager.enqueue('default', 'key1', async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      manager.enqueue('default', 'key1', async () => {});
      manager.enqueue('nested', 'key1', async () => {});

      await new Promise((r) => setTimeout(r, 10));

      const drained = manager.drain('key1');
      expect(drained).toBeGreaterThanOrEqual(1);

      // Queue depth should be reduced
      const depth = manager.getQueueDepth('key1');
      expect(depth).toBe(0);
    });

    it('should return 0 when draining unknown key', () => {
      const drained = manager.drain('unknown-key');
      expect(drained).toBe(0);
    });

    it('should not affect other lane keys', async () => {
      manager.enqueue('default', 'key1', async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      manager.enqueue('default', 'key2', async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      await new Promise((r) => setTimeout(r, 10));

      manager.drain('key1');

      expect(manager.getActiveCount()).toBeGreaterThanOrEqual(1);
    });
  });

  describe('kill-switch', () => {
    it('should route all tasks to default lane when SUDO_SESSION_LANES_DISABLE=1', async () => {
      // Set kill-switch BEFORE creating manager
      process.env.SUDO_SESSION_LANES_DISABLE = '1';
      resetLaneManager();
      const disabledManager = new SessionLaneManager();

      const executionOrder: string[] = [];

      // These should all be routed to 'default' lane and thus serialize
      const promises = [
        disabledManager.enqueue('default', 'key1', async () => {
          await new Promise((r) => setTimeout(r, 20));
          executionOrder.push('default');
        }),
        disabledManager.enqueue('nested', 'key1', async () => {
          await new Promise((r) => setTimeout(r, 20));
          executionOrder.push('nested');
        }),
        disabledManager.enqueue('subagent', 'key1', async () => {
          await new Promise((r) => setTimeout(r, 20));
          executionOrder.push('subagent');
        }),
        disabledManager.enqueue('cron', 'key1', async () => {
          await new Promise((r) => setTimeout(r, 20));
          executionOrder.push('cron');
        }),
      ];

      await Promise.all(promises);

      // Should be serialized (in order) since all routed to default
      expect(executionOrder).toEqual(['default', 'nested', 'subagent', 'cron']);
    });

    it('should report disabled state via isEnabled', () => {
      process.env.SUDO_SESSION_LANES_DISABLE = '1';
      resetLaneManager();
      const disabledManager = new SessionLaneManager();

      expect(disabledManager.isEnabled()).toBe(false);
    });

    it('should report enabled state when kill-switch is off', () => {
      delete process.env.SUDO_SESSION_LANES_DISABLE;
      resetLaneManager();
      const enabledManager = new SessionLaneManager();

      expect(enabledManager.isEnabled()).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return comprehensive statistics', async () => {
      const longTask = new Promise<void>((resolve) => setTimeout(resolve, 200));

      manager.enqueue('default', 'key1', () => longTask);
      manager.enqueue('default', 'key2', () => longTask);
      manager.enqueue('nested', 'key3', () => longTask);
      manager.enqueue('default', 'key1', async () => {}); // Queued behind first

      await new Promise((r) => setTimeout(r, 10));

      const stats = manager.getStats();

      expect(stats.totalActive).toBe(3);
      expect(stats.byLaneType.default).toBe(2);
      expect(stats.byLaneType.nested).toBe(1);
      expect(stats.byLaneType.subagent).toBe(0);
      expect(stats.byLaneType.cron).toBe(0);
      expect(stats.totalQueued).toBeGreaterThanOrEqual(1);
    });
  });

  describe('error handling', () => {
    it('should propagate task errors', async () => {
      const error = new Error('Task failed');

      await expect(
        manager.enqueue('default', 'key1', async () => {
          throw error;
        })
      ).rejects.toThrow('Task failed');
    });

    it('should continue processing other tasks after error', async () => {
      const results: string[] = [];

      const p1 = manager.enqueue('default', 'key1', async () => {
        throw new Error('First task fails');
      });

      const p2 = manager.enqueue('default', 'key1', async () => {
        results.push('second');
        return 'ok';
      });

      await expect(p1).rejects.toThrow();
      await p2;

      expect(results).toEqual(['second']);
    });

    it('should throw on invalid laneKey', () => {
      expect(() => manager.enqueue('default', '', async () => {})).toThrow();
      expect(() => manager.enqueue('default', null as any, async () => {})).toThrow();
    });

    it('should throw on invalid task', () => {
      expect(() => manager.enqueue('default', 'key1', null as any)).toThrow();
    });

    it('should throw on invalid laneKey for getQueueDepth', () => {
      expect(() => manager.getQueueDepth('')).toThrow();
    });

    it('should throw on invalid laneKey for drain', () => {
      expect(() => manager.drain('')).toThrow();
    });
  });

  describe('return values', () => {
    it('should return task result', async () => {
      const result = await manager.enqueue('default', 'key1', async () => {
        return { value: 42 };
      });

      expect(result).toEqual({ value: 42 });
    });

    it('should handle async return values', async () => {
      const result = await manager.enqueue('subagent', 'key1', async () => {
        await new Promise((r) => setTimeout(r, 10));
        return Promise.resolve('async result');
      });

      expect(result).toBe('async result');
    });
  });
});
