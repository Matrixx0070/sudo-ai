/**
 * readUpdateEnvOverrides — SUDO_UPDATE_* env tier (census F81 follow-up).
 * Pins the exact prod values that were previously inert, plus invalid-value
 * fall-through behavior.
 */
import { describe, it, expect } from 'vitest';
import { readUpdateEnvOverrides, DEFAULT_UPDATE_CONFIG } from '../../src/core/update/update-manager-types.js';

describe('readUpdateEnvOverrides', () => {
  it('maps the exact prod env set (previously inert)', () => {
    const out = readUpdateEnvOverrides({
      SUDO_UPDATE_AUTO_APPLY: '1',
      SUDO_UPDATE_CHANNEL: 'latest',
      SUDO_UPDATE_HEALTH_GATE: '1',
      SUDO_UPDATE_INTERVAL_MS: '1800000',
      SUDO_UPDATE_MAX_VERSION: '',
      SUDO_UPDATE_SKIP_VERSIONS: '',
    } as NodeJS.ProcessEnv);
    expect(out).toEqual({
      autoApply: true,
      channel: 'latest',
      healthGate: true,
      checkIntervalMs: 1_800_000,
    });
  });

  it('maps disables and lists', () => {
    const out = readUpdateEnvOverrides({
      SUDO_UPDATE_AUTO_APPLY: '0',
      SUDO_UPDATE_HEALTH_GATE: '0',
      SUDO_UPDATE_CHANNEL: 'stable',
      SUDO_UPDATE_MAX_VERSION: '4.2.0',
      SUDO_UPDATE_SKIP_VERSIONS: '4.1.9, 4.1.10,,',
      SUDO_UPDATE_ROLLBACK_VERSIONS: '5',
    } as NodeJS.ProcessEnv);
    expect(out).toEqual({
      autoApply: false,
      healthGate: false,
      channel: 'stable',
      maxVersion: '4.2.0',
      skipVersions: ['4.1.9', '4.1.10'],
      rollbackVersions: 5,
    });
  });

  it('ignores invalid values (fall through to defaults)', () => {
    const out = readUpdateEnvOverrides({
      SUDO_UPDATE_AUTO_APPLY: 'yes',
      SUDO_UPDATE_CHANNEL: 'nightly',
      SUDO_UPDATE_INTERVAL_MS: '5000', // below 60s floor
      SUDO_UPDATE_ROLLBACK_VERSIONS: '-1',
    } as NodeJS.ProcessEnv);
    expect(out).toEqual({});
  });

  it('empty env → empty overrides (defaults win)', () => {
    expect(readUpdateEnvOverrides({} as NodeJS.ProcessEnv)).toEqual({});
    expect({ ...DEFAULT_UPDATE_CONFIG, ...readUpdateEnvOverrides({} as NodeJS.ProcessEnv) }).toEqual(DEFAULT_UPDATE_CONFIG);
  });
});
