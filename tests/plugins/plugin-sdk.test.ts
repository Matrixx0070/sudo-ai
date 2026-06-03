/**
 * Plugin SDK Tests
 *
 * Tests for the SUDO-AI plugin system:
 * - Plugin lifecycle (install, activate, deactivate, uninstall)
 * - Plugin registration functions (registerTool, registerChannel, etc.)
 * - Hook subscription system (onHook)
 * - Cleanup functions
 * - listActive() functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginManager } from '../../src/core/plugins/manager.js';
import { PluginLoader } from '../../src/core/plugins/loader.js';
import type { PluginContext, PluginModule, PluginHookEvent } from '../../src/core/plugins/types.js';

// ---------------------------------------------------------------------------
// Mock Setup
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(function (this: typeof mockLogger) {
    return this;
  }),
};

const mockToolRegistry = {
  register: vi.fn(),
  unregister: vi.fn(),
  list: vi.fn(),
};

const mockConfig = {
  apiKey: 'test-key',
  debug: true,
};

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock plugin module for testing.
 */
function createMockPlugin(options?: {
  id?: string;
  name?: string;
  onActivate?: (ctx: PluginContext) => Promise<void>;
  onDeactivate?: () => Promise<void>;
}): PluginModule {
  return {
    manifest: {
      id: options?.id ?? 'test.plugin',
      name: options?.name ?? 'Test Plugin',
      version: '1.0.0',
      description: 'A test plugin',
      entryPoint: 'index.js',
      capabilities: ['tools' as const],
      ...(options?.id ? { config: {} } : {}),
    },
    activate: options?.onActivate ?? (async () => {}),
    deactivate: options?.onDeactivate,
  };
}

/**
 * Create a fresh PluginManager instance for testing.
 */
function createManager(): PluginManager {
  return new PluginManager(mockToolRegistry as unknown, mockConfig as unknown, mockLogger as unknown);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Plugin SDK', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Lifecycle Tests
  // -------------------------------------------------------------------------

  describe('Plugin Lifecycle', () => {
    it('should install a plugin without activating it', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';

      // Mock the loader to return our test plugin
      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({ id: 'test.lifecycle-plugin' })
      );

      try {
        const entry = await manager.install(pluginPath);

        expect(entry.manifest.id).toBe('test.lifecycle-plugin');
        expect(entry.state).toBe('installed');
        expect(entry.module).toBeDefined();
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should activate an installed plugin', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      const activateCalls: PluginContext[] = [];

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.activate-plugin',
          onActivate: async (ctx) => {
            activateCalls.push(ctx);
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.activate-plugin');

        const entry = manager.getPlugin('test.activate-plugin');
        expect(entry.state).toBe('active');
        expect(activateCalls.length).toBe(1);
        expect(activateCalls[0].pluginId).toBe('test.activate-plugin');
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should deactivate an active plugin', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let deactivateCalled = false;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.deactivate-plugin',
          onDeactivate: async () => {
            deactivateCalled = true;
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.deactivate-plugin');
        await manager.deactivate('test.deactivate-plugin');

        const entry = manager.getPlugin('test.deactivate-plugin');
        expect(entry.state).toBe('inactive');
        expect(deactivateCalled).toBe(true);
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should uninstall a plugin (deactivating first if active)', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let deactivateCalled = false;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.uninstall-plugin',
          onDeactivate: async () => {
            deactivateCalled = true;
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.uninstall-plugin');
        await manager.uninstall('test.uninstall-plugin');

        expect(deactivateCalled).toBe(true);

        // Should throw because plugin is no longer registered
        expect(() => manager.getPlugin('test.uninstall-plugin')).toThrow('not registered');
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should list active plugins', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn()
        .mockResolvedValueOnce(createMockPlugin({ id: 'test.plugin-a' }))
        .mockResolvedValueOnce(createMockPlugin({ id: 'test.plugin-b' }));

      try {
        await manager.install(pluginPath);
        await manager.activate('test.plugin-a');

        expect(manager.listActive()).toEqual(['test.plugin-a']);

        // Install and activate second plugin
        PluginLoader.prototype.loadPlugin = vi.fn()
          .mockResolvedValue(createMockPlugin({ id: 'test.plugin-b' }));
        await manager.install(pluginPath + '-b');
        await manager.activate('test.plugin-b');

        const active = manager.listActive();
        expect(active).toContain('test.plugin-a');
        expect(active).toContain('test.plugin-b');
        expect(active.length).toBe(2);
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Plugin Context Tests
  // -------------------------------------------------------------------------

  describe('PluginContext', () => {
    it('should provide pluginId in context', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let capturedContext: PluginContext | null = null;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.context-plugin',
          onActivate: async (ctx) => {
            capturedContext = ctx;
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.context-plugin');

        expect(capturedContext).not.toBeNull();
        expect(capturedContext!.pluginId).toBe('test.context-plugin');
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should provide logger in context', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let capturedContext: PluginContext | null = null;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.logger-plugin',
          onActivate: async (ctx) => {
            capturedContext = ctx;
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.logger-plugin');

        expect(capturedContext!.logger).toBeDefined();
        expect(typeof capturedContext!.logger.info).toBe('function');
        expect(typeof capturedContext!.logger.warn).toBe('function');
        expect(typeof capturedContext!.logger.error).toBe('function');
        expect(typeof capturedContext!.logger.debug).toBe('function');
        expect(typeof capturedContext!.logger.child).toBe('function');
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should provide config in context', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let capturedContext: PluginContext | null = null;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.config-plugin',
          onActivate: async (ctx) => {
            capturedContext = ctx;
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.config-plugin');

        // Context should have config (normalized from manifest.config schema)
        expect(capturedContext).not.toBeNull();
        expect(capturedContext!.config).toBeDefined();
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Registration Tests
  // -------------------------------------------------------------------------

  describe('registerTool', () => {
    it('should return a cleanup function', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let cleanupFn: (() => void) | null = null;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.tool-plugin',
          onActivate: async (ctx) => {
            cleanupFn = ctx.registerTool({
              name: 'test-tool',
              description: 'A test tool',
              inputSchema: { type: 'object' },
              execute: async () => ({ result: 'ok' }),
            });
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.tool-plugin');

        expect(cleanupFn).not.toBeNull();
        expect(typeof cleanupFn).toBe('function');

        // Cleanup should not throw
        cleanupFn!();
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });
  });

  describe('registerChannel', () => {
    it('should return a cleanup function', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let cleanupFn: (() => void) | null = null;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.channel-plugin',
          onActivate: async (ctx) => {
            cleanupFn = ctx.registerChannel({
              id: 'test-channel',
              name: 'Test Channel',
              type: 'websocket',
              onConnect: async () => {},
              onMessage: async () => {},
              onDisconnect: async () => {},
            });
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.channel-plugin');

        expect(cleanupFn).not.toBeNull();
        expect(typeof cleanupFn).toBe('function');
        cleanupFn!();
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });
  });

  describe('registerProvider', () => {
    it('should return a cleanup function', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let cleanupFn: (() => void) | null = null;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.provider-plugin',
          onActivate: async (ctx) => {
            cleanupFn = ctx.registerProvider({
              id: 'test-provider',
              name: 'Test Provider',
              type: 'llm',
              capabilities: { contextWindow: 8192 },
              complete: async () => ({ text: 'response' }),
            });
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.provider-plugin');

        expect(cleanupFn).not.toBeNull();
        expect(typeof cleanupFn).toBe('function');
        cleanupFn!();
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });
  });

  describe('registerSkill', () => {
    it('should return a cleanup function', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let cleanupFn: (() => void) | null = null;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.skill-plugin',
          onActivate: async (ctx) => {
            cleanupFn = ctx.registerSkill({
              id: 'test-skill',
              name: 'Test Skill',
              description: 'A test skill',
              category: 'utility',
              execute: async () => ({ success: true }),
            });
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.skill-plugin');

        expect(cleanupFn).not.toBeNull();
        expect(typeof cleanupFn).toBe('function');
        cleanupFn!();
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Hook Subscription Tests
  // -------------------------------------------------------------------------

  describe('onHook', () => {
    it('should return a subscription with unsubscribe method', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let subscription: ReturnType<PluginContext['onHook']> | null = null;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.hook-plugin',
          onActivate: async (ctx) => {
            subscription = ctx.onHook('tool:call:before', () => {});
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.hook-plugin');

        expect(subscription).not.toBeNull();
        expect(subscription!.active).toBe(true);
        expect(typeof subscription!.unsubscribe).toBe('function');
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should call hook handler when event is emitted', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let handlerCalled = false;
      let handlerData: unknown = null;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.hook-caller-plugin',
          onActivate: async (ctx) => {
            ctx.onHook('plugin:activated', (data) => {
              handlerCalled = true;
              handlerData = data;
            });
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.hook-caller-plugin');

        // The hook should have been called during activation
        expect(handlerCalled).toBe(true);
        expect(handlerData).toEqual({ id: 'test.hook-caller-plugin' });
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should stop calling handler after unsubscribe', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let callCount = 0;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.unsubscribe-plugin',
          onActivate: async (ctx) => {
            const sub = ctx.onHook('session:start', () => {
              callCount++;
            });
            // Unsubscribe immediately
            sub.unsubscribe();
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.unsubscribe-plugin');

        // Emit the event manually
        await (manager as any).emitHook('session:start', { sessionId: 'test' });

        // Handler should not have been called (or only called before unsubscribe)
        expect(callCount).toBe(0);
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should handle async hook handlers', async () => {
      const manager = createManager();
      let asyncHandlerCalled = false;

      // Direct test of emitHook with async handler
      const sub = (manager as any).subscribeHook('test-async', 'session:end', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        asyncHandlerCalled = true;
      });

      await (manager as any).emitHook('session:end', { sessionId: 'async-test' });

      expect(asyncHandlerCalled).toBe(true);
      sub.unsubscribe();
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup Tests
  // -------------------------------------------------------------------------

  describe('Cleanup Functions', () => {
    it('should clean up registrations on deactivate', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let cleanupCalled = false;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.cleanup-plugin',
          onActivate: async (ctx) => {
            ctx.registerTool({
              name: 'test-tool',
              description: 'Test',
              inputSchema: {},
              execute: async () => ({}),
            });
          },
          onDeactivate: async () => {
            cleanupCalled = true;
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.cleanup-plugin');
        await manager.deactivate('test.cleanup-plugin');

        expect(cleanupCalled).toBe(true);
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should remove hook subscriptions on deactivate', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';
      let handlerCalledAfterDeactivate = false;

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.hook-cleanup-plugin',
          onActivate: async (ctx) => {
            ctx.onHook('session:start', () => {
              handlerCalledAfterDeactivate = true;
            });
          },
        })
      );

      try {
        await manager.install(pluginPath);
        await manager.activate('test.hook-cleanup-plugin');
        await manager.deactivate('test.hook-cleanup-plugin');

        // Emit event after deactivate
        await (manager as any).emitHook('session:start', {});

        // Handler should not be called after unsubscribe during deactivate
        expect(handlerCalledAfterDeactivate).toBe(false);
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Error Handling Tests
  // -------------------------------------------------------------------------

  describe('Error Handling', () => {
    it('should throw on invalid plugin id', async () => {
      const manager = createManager();

      await expect(manager.activate('')).rejects.toThrow('non-empty string');
      await expect(manager.deactivate('')).rejects.toThrow('non-empty string');
      await expect(manager.uninstall('')).rejects.toThrow('non-empty string');
    });

    it('should throw on unknown plugin id', async () => {
      const manager = createManager();

      await expect(manager.activate('unknown-plugin')).rejects.toThrow('not registered');
    });

    it('should handle activation failure gracefully', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({
          id: 'test.failing-plugin',
          onActivate: async () => {
            throw new Error('Activation failed!');
          },
        })
      );

      try {
        await manager.install(pluginPath);

        await expect(manager.activate('test.failing-plugin')).rejects.toThrow('Activation failed');

        const entry = manager.getPlugin('test.failing-plugin');
        expect(entry.state).toBe('error');
        expect(entry.error).toContain('Activation failed');
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });
  });

  // -------------------------------------------------------------------------
  // getPluginContext Tests
  // -------------------------------------------------------------------------

  describe('getPluginContext', () => {
    it('should return a valid PluginContext', async () => {
      const manager = createManager();
      const pluginPath = '/tmp/test-plugin';

      const originalLoadPlugin = PluginLoader.prototype.loadPlugin;
      PluginLoader.prototype.loadPlugin = vi.fn().mockResolvedValue(
        createMockPlugin({ id: 'test.context-fetch-plugin' })
      );

      try {
        await manager.install(pluginPath);

        const ctx = manager.getPluginContext('test.context-fetch-plugin');

        expect(ctx.pluginId).toBe('test.context-fetch-plugin');
        expect(typeof ctx.registerTool).toBe('function');
        expect(typeof ctx.registerChannel).toBe('function');
        expect(typeof ctx.registerProvider).toBe('function');
        expect(typeof ctx.registerSkill).toBe('function');
        expect(typeof ctx.onHook).toBe('function');
      } finally {
        PluginLoader.prototype.loadPlugin = originalLoadPlugin;
      }
    });

    it('should throw for unknown plugin', () => {
      const manager = createManager();

      expect(() => manager.getPluginContext('unknown')).toThrow('not registered');
    });
  });
});
