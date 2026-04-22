/**
 * Unit tests for ConfigLoader.
 * All filesystem reads are mocked — no real files are read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSON5 from 'json5';

// ---------------------------------------------------------------------------
// Use vi.hoisted() so these functions are available inside the vi.mock() factory
// which is hoisted to the top of the compiled output.
// ---------------------------------------------------------------------------

const { mockReadFileSync, mockExistsSync, mockWatch } = vi.hoisted(() => {
  const mockReadFileSync = vi.fn();
  const mockExistsSync = vi.fn();
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

import { ConfigLoader } from '../../../src/core/config/loader.js';
import { ConfigError } from '../../../src/core/shared/errors.js';
import { validConfig } from '../../helpers/fixtures.js';

describe('ConfigLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: .env does not exist, config file exists for initial load
    mockExistsSync.mockImplementation((p: unknown) => {
      const pathStr = String(p);
      if (pathStr.includes('.env')) return false;
      return true; // config file exists for watcher check
    });
    // Default watch returns a mock FSWatcher
    mockWatch.mockReturnValue({ on: vi.fn(), close: vi.fn() });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // load() — success path
  // -------------------------------------------------------------------------

  it('loads a valid config from a JSON5 string', async () => {
    const raw = JSON5.stringify(validConfig);
    mockReadFileSync.mockReturnValue(raw);

    const loader = new ConfigLoader('/fake/root');
    await loader.load();

    const cfg = loader.get();
    expect(cfg.meta.name).toBe('TestAgent');
    expect(cfg.agents.maxIterations).toBe(10);
    loader.close();
  });

  it('returns the same config object on subsequent get() calls', async () => {
    mockReadFileSync.mockReturnValue(JSON5.stringify(validConfig));

    const loader = new ConfigLoader('/fake/root');
    await loader.load();

    const a = loader.get();
    const b = loader.get();
    expect(a).toBe(b);
    loader.close();
  });

  // -------------------------------------------------------------------------
  // load() — error paths
  // -------------------------------------------------------------------------

  it('throws ConfigError when the config file cannot be read', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const loader = new ConfigLoader('/fake/root');
    await expect(loader.load()).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError matching "Cannot read config file" message', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const loader = new ConfigLoader('/fake/root');
    await expect(loader.load()).rejects.toThrow('Cannot read config file');
  });

  it('throws ConfigError with code config_read_error on missing file', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const loader = new ConfigLoader('/fake/root');
    try {
      await loader.load();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('config_read_error');
    }
  });

  it('throws ConfigError on invalid JSON5 syntax', async () => {
    mockReadFileSync.mockReturnValue('{ this is not valid json5 !!!');

    const loader = new ConfigLoader('/fake/root');
    await expect(loader.load()).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError with code config_parse_error on malformed JSON5', async () => {
    mockReadFileSync.mockReturnValue('{ bad: json syntax ');

    const loader = new ConfigLoader('/fake/root');
    try {
      await loader.load();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('config_parse_error');
    }
  });

  it('throws ConfigError on schema validation failure', async () => {
    const bad = JSON5.stringify({ meta: { name: '', timezone: 'UTC' } });
    mockReadFileSync.mockReturnValue(bad);

    const loader = new ConfigLoader('/fake/root');
    await expect(loader.load()).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError with code config_validation_error on invalid schema', async () => {
    const bad = JSON5.stringify({ meta: { name: '', timezone: 'UTC' } });
    mockReadFileSync.mockReturnValue(bad);

    const loader = new ConfigLoader('/fake/root');
    try {
      await loader.load();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('config_validation_error');
    }
  });

  // -------------------------------------------------------------------------
  // get() — before load()
  // -------------------------------------------------------------------------

  it('throws ConfigError when get() called before load()', () => {
    const loader = new ConfigLoader('/fake/root');
    expect(() => loader.get()).toThrow(ConfigError);
  });

  it('throws error containing "not loaded" when get() called before load()', () => {
    const loader = new ConfigLoader('/fake/root');
    expect(() => loader.get()).toThrow('not loaded');
  });

  it('throws with code config_not_loaded', () => {
    const loader = new ConfigLoader('/fake/root');
    try {
      loader.get();
    } catch (e) {
      expect((e as ConfigError).code).toBe('config_not_loaded');
    }
  });

  // -------------------------------------------------------------------------
  // Env variable interpolation
  // -------------------------------------------------------------------------

  it('replaces ${ENV_VAR} placeholders with process.env values', async () => {
    process.env['TEST_MY_API_KEY'] = 'secret-value-123';

    const raw = JSON5.stringify({
      ...validConfig,
      auth: {
        ...validConfig.auth,
        xai: { envKey: '${TEST_MY_API_KEY}' },
      },
    });
    mockReadFileSync.mockReturnValue(raw);

    const loader = new ConfigLoader('/fake/root');
    await loader.load();
    const cfg = loader.get();
    expect(cfg.auth.xai.envKey).toBe('secret-value-123');

    delete process.env['TEST_MY_API_KEY'];
    loader.close();
  });

  it('replaces undefined env vars with empty string and causes validation to fail', async () => {
    delete process.env['UNDEFINED_VAR_ABC'];
    const raw = JSON5.stringify({
      ...validConfig,
      gateway: { ...validConfig.gateway, secretEnvKey: '${UNDEFINED_VAR_ABC}' },
    });
    mockReadFileSync.mockReturnValue(raw);

    const loader = new ConfigLoader('/fake/root');
    // secretEnvKey becomes '' which fails minLength:1 validation -> ConfigError
    await expect(loader.load()).rejects.toThrow(ConfigError);
  });

  // -------------------------------------------------------------------------
  // onReload
  // -------------------------------------------------------------------------

  it('registers a reload callback via onReload() and returns this for chaining', async () => {
    mockReadFileSync.mockReturnValue(JSON5.stringify(validConfig));

    const loader = new ConfigLoader('/fake/root');
    await loader.load();

    const cb = vi.fn();
    const returned = loader.onReload(cb);
    expect(returned).toBe(loader);

    loader.close();
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  it('can be closed without throwing even before load()', () => {
    const loader = new ConfigLoader('/fake/root');
    expect(() => loader.close()).not.toThrow();
  });

  it('close() does not throw when called multiple times', async () => {
    mockReadFileSync.mockReturnValue(JSON5.stringify(validConfig));

    const loader = new ConfigLoader('/fake/root');
    await loader.load();
    loader.close();
    expect(() => loader.close()).not.toThrow();
  });
});
