/**
 * Unit tests for meta tools that depend on injected runtime singletons.
 *
 * These tests verify that uninitialized tools (agentLoop, channelRouter,
 * memoryEngine) return a graceful, non-throwing error result rather than
 * crashing. Each test calls injectMetaToolDeps() to reset state before and
 * after to avoid cross-test contamination.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { injectMetaToolDeps } from '../../../src/core/tools/builtin/meta/index.js';
import { sessionsSpawnTool } from '../../../src/core/tools/builtin/meta/sessions-spawn.js';
import { messageSendTool } from '../../../src/core/tools/builtin/meta/message-send.js';
import { memorySearchTool } from '../../../src/core/tools/builtin/meta/memory-search.js';
import { makeToolContext } from '../../helpers/mocks.js';

// ---------------------------------------------------------------------------
// Helper: reset all injected singletons to null before each test
// ---------------------------------------------------------------------------

function clearDeps(): void {
  injectMetaToolDeps({
    sessionManager: null,
    agentLoop: null,
    cronManager: null,
    channelRouter: null,
    memoryEngine: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('meta tools — uninitialized dependency graceful error', () => {
  beforeEach(() => {
    clearDeps();
  });

  afterEach(() => {
    clearDeps();
  });

  // -------------------------------------------------------------------------
  // sessions.spawn — requires agentLoop
  // -------------------------------------------------------------------------

  describe('sessions.spawn', () => {
    it('returns success: false when agentLoop is not injected', async () => {
      const ctx = makeToolContext();
      const result = await sessionsSpawnTool.execute(
        { task: 'Do something' },
        ctx,
      );
      expect(result.success).toBe(false);
    });

    it('includes "not been initialised" in the output when agentLoop is missing', async () => {
      const ctx = makeToolContext();
      const result = await sessionsSpawnTool.execute(
        { task: 'Do something' },
        ctx,
      );
      expect(result.output).toMatch(/not been initialised|not initialised/i);
    });

    it('does NOT throw when agentLoop is not injected', async () => {
      const ctx = makeToolContext();
      await expect(
        sessionsSpawnTool.execute({ task: 'Do something' }, ctx),
      ).resolves.not.toThrow();
    });

    it('returns success: false for missing task param (validation before dep check)', async () => {
      const ctx = makeToolContext();
      const result = await sessionsSpawnTool.execute({ task: '' }, ctx);
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/required/i);
    });

    it('returns success: false for null/undefined task param', async () => {
      const ctx = makeToolContext();
      const result = await sessionsSpawnTool.execute({}, ctx);
      expect(result.success).toBe(false);
    });

    it('returns a result (not throws) even with both missing task AND missing dep', async () => {
      const ctx = makeToolContext();
      const result = await sessionsSpawnTool.execute({}, ctx);
      expect(typeof result.output).toBe('string');
    });

    it('succeeds normally when agentLoop and sessionManager are injected', async () => {
      const mockLoop = {
        run: vi.fn(async () => ({ text: 'done', attachments: [] })),
      };
      const mockSessionManager = {
        getOrCreate: vi.fn(async () => ({ id: 'new-sess-id' })),
      };
      injectMetaToolDeps({ agentLoop: mockLoop, sessionManager: mockSessionManager });

      const ctx = makeToolContext();
      const result = await sessionsSpawnTool.execute(
        { task: 'Handle this task' },
        ctx,
      );
      expect(result.success).toBe(true);
      expect(mockSessionManager.getOrCreate).toHaveBeenCalledOnce();
      expect(mockLoop.run).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // message.send — requires channelRouter
  // -------------------------------------------------------------------------

  describe('message.send', () => {
    it('returns success: false when channelRouter is not injected', async () => {
      const ctx = makeToolContext();
      const result = await messageSendTool.execute(
        { channel: 'telegram', peerId: 'user-1', text: 'Hello' },
        ctx,
      );
      expect(result.success).toBe(false);
    });

    it('includes "not been initialised" in the output', async () => {
      const ctx = makeToolContext();
      const result = await messageSendTool.execute(
        { channel: 'telegram', peerId: 'user-1', text: 'Hello' },
        ctx,
      );
      expect(result.output).toMatch(/not been initialised|not initialised/i);
    });

    it('does NOT throw when channelRouter is not injected', async () => {
      const ctx = makeToolContext();
      await expect(
        messageSendTool.execute({ channel: 'telegram', peerId: 'user-1', text: 'Hi' }, ctx),
      ).resolves.not.toThrow();
    });

    it('validates required params before checking the dep — missing channel', async () => {
      const ctx = makeToolContext();
      const result = await messageSendTool.execute(
        { channel: '', peerId: 'user-1', text: 'Hi' },
        ctx,
      );
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/required/i);
    });

    it('validates required params — missing peerId', async () => {
      const ctx = makeToolContext();
      const result = await messageSendTool.execute(
        { channel: 'telegram', peerId: '', text: 'Hi' },
        ctx,
      );
      expect(result.success).toBe(false);
    });

    it('validates required params — missing text', async () => {
      const ctx = makeToolContext();
      const result = await messageSendTool.execute(
        { channel: 'telegram', peerId: 'user-1', text: '' },
        ctx,
      );
      expect(result.success).toBe(false);
    });

    it('succeeds when channelRouter is injected', async () => {
      const mockRouter = {
        send: vi.fn(async () => ({ messageId: 'msg-123', timestamp: new Date().toISOString() })),
      };
      injectMetaToolDeps({ channelRouter: mockRouter });

      const ctx = makeToolContext();
      const result = await messageSendTool.execute(
        { channel: 'telegram', peerId: 'user-1', text: 'Hello world' },
        ctx,
      );
      expect(result.success).toBe(true);
      expect(mockRouter.send).toHaveBeenCalledWith('telegram', 'user-1', 'Hello world');
    });
  });

  // -------------------------------------------------------------------------
  // memory.search — requires memoryEngine
  // -------------------------------------------------------------------------

  describe('memory.search', () => {
    it('returns success: false when memoryEngine is not injected', async () => {
      const ctx = makeToolContext();
      const result = await memorySearchTool.execute(
        { query: 'what happened yesterday' },
        ctx,
      );
      expect(result.success).toBe(false);
    });

    it('includes "not been initialised" in the output', async () => {
      const ctx = makeToolContext();
      const result = await memorySearchTool.execute(
        { query: 'what happened yesterday' },
        ctx,
      );
      expect(result.output).toMatch(/not been initialised|not initialised/i);
    });

    it('does NOT throw when memoryEngine is not injected', async () => {
      const ctx = makeToolContext();
      await expect(
        memorySearchTool.execute({ query: 'search query' }, ctx),
      ).resolves.not.toThrow();
    });

    it('validates required query param before dep check — empty query', async () => {
      const ctx = makeToolContext();
      const result = await memorySearchTool.execute({ query: '' }, ctx);
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/required/i);
    });

    it('validates required query param — missing entirely', async () => {
      const ctx = makeToolContext();
      const result = await memorySearchTool.execute({}, ctx);
      expect(result.success).toBe(false);
    });

    it('succeeds and returns results when memoryEngine is injected', async () => {
      const mockEngine = {
        search: vi.fn(async () => [
          { key: 'note-1', content: 'Yesterday was productive', score: 0.95 },
        ]),
      };
      injectMetaToolDeps({ memoryEngine: mockEngine });

      const ctx = makeToolContext();
      const result = await memorySearchTool.execute(
        { query: 'what happened yesterday', limit: 5 },
        ctx,
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('1 result');
      expect(mockEngine.search).toHaveBeenCalledWith('what happened yesterday', 5);
    });

    it('returns success: true with empty results message when no matches', async () => {
      const mockEngine = {
        search: vi.fn(async () => []),
      };
      injectMetaToolDeps({ memoryEngine: mockEngine });

      const ctx = makeToolContext();
      const result = await memorySearchTool.execute({ query: 'nothing here' }, ctx);
      expect(result.success).toBe(true);
      expect(result.output).toContain('No memory results');
    });

    it('returns success: false and error message when engine throws', async () => {
      const mockEngine = {
        search: vi.fn(async () => { throw new Error('DB offline'); }),
      };
      injectMetaToolDeps({ memoryEngine: mockEngine });

      const ctx = makeToolContext();
      const result = await memorySearchTool.execute({ query: 'something' }, ctx);
      expect(result.success).toBe(false);
      expect(result.output).toContain('DB offline');
    });
  });

  // -------------------------------------------------------------------------
  // injectMetaToolDeps — partial injection
  // -------------------------------------------------------------------------

  describe('injectMetaToolDeps partial injection', () => {
    it('injects only agentLoop without affecting channelRouter', async () => {
      const mockLoop = {
        run: vi.fn(async () => ({ sessionId: 'new-sess', output: 'ok' })),
      };
      injectMetaToolDeps({ agentLoop: mockLoop });

      // channelRouter is still null — message.send should return not-initialised
      const ctx = makeToolContext();
      const result = await messageSendTool.execute(
        { channel: 'telegram', peerId: 'u1', text: 'Hi' },
        ctx,
      );
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/not been initialised|not initialised/i);
    });
  });
});
