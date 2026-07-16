import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadGdriveConfig,
  isGdriveEnabled,
  GdriveConfigError,
} from '../../src/core/gdrive/config.js';

const tmp = mkdtempSync(join(tmpdir(), 'gdrive-config-'));
const keyFile = join(tmp, 'sa-key.json');
writeFileSync(keyFile, '{}');

describe('gdrive config', () => {
  it('is disabled by default and skips validation when off', () => {
    expect(isGdriveEnabled({})).toBe(false);
    const cfg = loadGdriveConfig({});
    expect(cfg.enabled).toBe(false);
    // No throw despite missing credentials/root.
  });

  it('fails fast with actionable messages when enabled but incomplete', () => {
    expect(() => loadGdriveConfig({ SUDO_GDRIVE: '1' })).toThrow(GdriveConfigError);
    expect(() => loadGdriveConfig({ SUDO_GDRIVE: '1' })).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/);
    expect(() =>
      loadGdriveConfig({ SUDO_GDRIVE: '1', GOOGLE_APPLICATION_CREDENTIALS: '/nope/missing.json' }),
    ).toThrow(/missing file/);
    expect(() =>
      loadGdriveConfig({ SUDO_GDRIVE: '1', GOOGLE_APPLICATION_CREDENTIALS: keyFile }),
    ).toThrow(/GDRIVE_ROOT_FOLDER_ID/);
  });

  it('loads a valid service-account config with defaults', () => {
    const cfg = loadGdriveConfig({
      SUDO_GDRIVE: '1',
      GOOGLE_APPLICATION_CREDENTIALS: keyFile,
      GDRIVE_ROOT_FOLDER_ID: 'abc123',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.authMode).toBe('service_account');
    expect(cfg.requestsPerSecond).toBe(5);
    expect(cfg.burst).toBe(10);
    expect(cfg.maxRetries).toBe(5);
    expect(cfg.heartbeatIntervalMs).toBe(5 * 60 * 1000);
  });

  it('honors numeric overrides and clamps garbage to defaults', () => {
    const base = {
      SUDO_GDRIVE: '1',
      GOOGLE_APPLICATION_CREDENTIALS: keyFile,
      GDRIVE_ROOT_FOLDER_ID: 'abc123',
    };
    const cfg = loadGdriveConfig({ ...base, GDRIVE_RPS: '2', GDRIVE_BURST: 'garbage' });
    expect(cfg.requestsPerSecond).toBe(2);
    expect(cfg.burst).toBe(10);
  });

  it('rejects an unknown auth mode and validates oauth file requirements', () => {
    const base = { SUDO_GDRIVE: '1', GDRIVE_ROOT_FOLDER_ID: 'abc' };
    expect(() => loadGdriveConfig({ ...base, GDRIVE_AUTH_MODE: 'oob' })).toThrow(/GDRIVE_AUTH_MODE/);
    expect(() => loadGdriveConfig({ ...base, GDRIVE_AUTH_MODE: 'oauth' })).toThrow(
      /GDRIVE_OAUTH_CLIENT_FILE/,
    );
  });
});
