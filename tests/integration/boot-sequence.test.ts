/**
 * Integration tests for the boot sequence.
 *
 * These tests are lightweight — no database or network calls.
 * They verify that:
 *   - Config loader + schema validation work end-to-end
 *   - Constants are importable and correct
 *   - Shared utilities work correctly together
 *   - Shared error classes behave as expected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Use vi.hoisted() so mock functions are available inside the vi.mock() factory,
// which is hoisted to the top of the compiled module.
// ---------------------------------------------------------------------------

const { mockReadFileSync, mockExistsSync, mockWatch } = vi.hoisted(() => {
  const mockReadFileSync = vi.fn();
  const mockExistsSync = vi.fn(() => false);
  const mockWatch = vi.fn(() => ({ on: vi.fn(), close: vi.fn() }));
  return { mockReadFileSync, mockExistsSync, mockWatch };
});

vi.mock('fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    watch: mockWatch,
  },
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  watch: mockWatch,
}));

import JSON5 from 'json5';
import { Value } from '@sinclair/typebox/value';

// ---------------------------------------------------------------------------
// Config loader end-to-end
// ---------------------------------------------------------------------------

describe('Boot sequence — config loader + schema validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockWatch.mockReturnValue({ on: vi.fn(), close: vi.fn() });
  });

  it('ConfigLoader loads and validates a complete config without errors', async () => {
    const { ConfigLoader } = await import('../../src/core/config/loader.js');
    const { validConfig } = await import('../helpers/fixtures.js');

    mockReadFileSync.mockReturnValue(JSON5.stringify(validConfig));

    const loader = new ConfigLoader('/test/root');
    await loader.load();
    const cfg = loader.get();

    expect(cfg.meta.name).toBe('TestAgent');
    expect(cfg.agents.maxIterations).toBe(10);
    expect(cfg.models.primary).toHaveLength(1);
    expect(cfg.gateway.enabled).toBe(false);
    loader.close();
  });

  it('ConfigLoader rejects config with schema violations', async () => {
    const { ConfigLoader } = await import('../../src/core/config/loader.js');
    const { ConfigError } = await import('../../src/core/shared/errors.js');

    const invalid = JSON5.stringify({
      meta: { name: '', timezone: 'UTC' },
    });
    mockReadFileSync.mockReturnValue(invalid);

    const loader = new ConfigLoader('/test/root');
    await expect(loader.load()).rejects.toThrow(ConfigError);
  });

  it('SudoConfigSchema validates validConfig successfully end-to-end', async () => {
    const { SudoConfigSchema } = await import('../../src/core/config/schema.js');
    const { validConfig } = await import('../helpers/fixtures.js');

    expect(Value.Check(SudoConfigSchema, validConfig)).toBe(true);
  });

  it('config hot-reload callback is invoked after manual reload()', async () => {
    const { ConfigLoader } = await import('../../src/core/config/loader.js');
    const { validConfig } = await import('../helpers/fixtures.js');

    mockReadFileSync.mockReturnValue(JSON5.stringify(validConfig));

    const loader = new ConfigLoader('/test/root');
    await loader.load();

    const reloadCb = vi.fn();
    loader.onReload(reloadCb);
    loader.reload();

    expect(reloadCb).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { name: 'TestAgent', timezone: 'UTC' } }),
    );
    loader.close();
  });
});

// ---------------------------------------------------------------------------
// Constants importability
// ---------------------------------------------------------------------------

describe('Boot sequence — constants importability', () => {
  it('APP_NAME can be imported and equals SUDO-AI', async () => {
    const { APP_NAME } = await import('../../src/core/shared/constants.js');
    expect(APP_NAME).toBe('SUDO-AI');
  });

  it('PATHS.CONFIG points to config/sudo-ai.json5', async () => {
    const { PATHS } = await import('../../src/core/shared/constants.js');
    expect(PATHS.CONFIG).toContain('sudo-ai.json5');
  });

  it('MAX_AGENT_ITERATIONS is a reasonable value (>= 5 and <= 1000)', async () => {
    const { MAX_AGENT_ITERATIONS } = await import('../../src/core/shared/constants.js');
    expect(MAX_AGENT_ITERATIONS).toBeGreaterThanOrEqual(5);
    expect(MAX_AGENT_ITERATIONS).toBeLessThanOrEqual(1000);
  });

  // DEFAULT_MODEL === FALLBACK_MODEL intentionally — unified local gateway routes all models.
});

// ---------------------------------------------------------------------------
// Utility functions end-to-end
// ---------------------------------------------------------------------------

describe('Boot sequence — shared utilities end-to-end', () => {
  it('genId() generates a valid nanoid string', async () => {
    const { genId } = await import('../../src/core/shared/utils.js');
    const id = genId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(10);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('retry() resolves immediately on success', async () => {
    const { retry } = await import('../../src/core/shared/utils.js');
    const result = await retry(async () => 'success', 3, [0]);
    expect(result).toBe('success');
  });

  it('retry() retries the correct number of times', async () => {
    const { retry } = await import('../../src/core/shared/utils.js');
    let count = 0;
    await retry(
      async () => {
        count++;
        if (count < 3) throw new Error('not yet');
        return 'ok';
      },
      5,
      [0, 0, 0, 0],
    );
    expect(count).toBe(3);
  });

  it('sleep() with 0ms resolves without error', async () => {
    const { sleep } = await import('../../src/core/shared/utils.js');
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it('truncate() handles edge cases correctly', async () => {
    const { truncate } = await import('../../src/core/shared/utils.js');
    expect(truncate('', 10)).toBe('');
    expect(truncate('short', 100)).toBe('short');
    const long = 'a'.repeat(50);
    expect(truncate(long, 10).length).toBeLessThanOrEqual(10);
  });

  it('contentHash() and safeJsonParse() work together', async () => {
    const { contentHash, safeJsonParse } = await import('../../src/core/shared/utils.js');
    const obj = { key: 'value', count: 42 };
    const json = JSON.stringify(obj);
    const hash = contentHash(json);
    const parsed = safeJsonParse<typeof obj>(json, { key: '', count: 0 });

    expect(hash).toHaveLength(64);
    expect(parsed.key).toBe('value');
    expect(parsed.count).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

describe('Boot sequence — error classes', () => {
  it('ConfigError is an instance of Error and has correct name', async () => {
    const { ConfigError } = await import('../../src/core/shared/errors.js');
    const err = new ConfigError('test message', 'config_test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ConfigError');
    expect(err.code).toBe('config_test');
    expect(err.message).toBe('test message');
  });

  it('ToolError carries structured details', async () => {
    const { ToolError } = await import('../../src/core/shared/errors.js');
    const err = new ToolError('tool failed', 'tool_test_error', { name: 'my.tool' });
    expect(err.details?.['name']).toBe('my.tool');
  });

  it('PipelineError is catchable as a generic Error', async () => {
    const { PipelineError } = await import('../../src/core/shared/errors.js');
    const fn = () => { throw new PipelineError('pipeline broke', 'pipeline_test'); };
    expect(fn).toThrow(Error);
    expect(fn).toThrow('pipeline broke');
  });

  it('LLMError code must start with llm_', async () => {
    const { LLMError } = await import('../../src/core/shared/errors.js');
    const err = new LLMError('llm failed', 'llm_rate_limit');
    expect(err.code).toMatch(/^llm_/);
  });

  it('categorizeError maps HTTP status codes correctly', async () => {
    const { categorizeError } = await import('../../src/core/shared/errors.js');
    expect(categorizeError(429)).toBe('rate_limit');
    expect(categorizeError(402)).toBe('billing');
    expect(categorizeError(503)).toBe('overloaded');
    expect(categorizeError(401)).toBe('auth');
    expect(categorizeError(403)).toBe('auth_permanent');
    expect(categorizeError(404)).toBe('model_not_found');
    expect(categorizeError(400, 'session expired')).toBe('session_expired');
    expect(categorizeError(400, 'model not found')).toBe('model_not_found');
    expect(categorizeError(400)).toBe('format');
    expect(categorizeError(500)).toBe('overloaded');
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry basic integration
// ---------------------------------------------------------------------------

describe('Boot sequence — ToolRegistry basic integration', () => {
  it('can register tools and retrieve schemas', async () => {
    const { ToolRegistry } = await import('../../src/core/tools/registry.js');
    const registry = new ToolRegistry();

    registry.register({
      name: 'system.test',
      description: 'A test tool',
      category: 'system',
      parameters: {
        input: { type: 'string', description: 'input', required: true },
      },
      execute: async () => ({ success: true, output: 'ok' }),
    });

    const schemas = registry.getSchemaForLLM();
    expect(schemas).toHaveLength(1);

    const schema = schemas[0] as { function: { name: string; parameters: { required: string[] } } };
    expect(schema.function.name).toBe('system.test');
    expect(schema.function.parameters.required).toContain('input');
  });

  it('disabled tools are excluded from LLM schema', async () => {
    const { ToolRegistry } = await import('../../src/core/tools/registry.js');
    const registry = new ToolRegistry();

    registry.register({
      name: 'system.enabled',
      description: 'Enabled tool',
      category: 'system',
      parameters: {},
      execute: async () => ({ success: true, output: 'ok' }),
    });
    registry.register({
      name: 'system.disabled',
      description: 'Disabled tool',
      category: 'system',
      parameters: {},
      execute: async () => ({ success: true, output: 'ok' }),
    });
    registry.disable('system.disabled');

    const schemas = registry.getSchemaForLLM();
    expect(schemas).toHaveLength(1);
    const s = schemas[0] as { function: { name: string } };
    expect(s.function.name).toBe('system.enabled');
  });
});
