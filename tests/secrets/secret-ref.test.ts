/**
 * @file tests/secrets/secret-ref.test.ts
 * @description SecretRef indirect-secret resolution + no-raw-log posture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSecretValue,
  resolveSecretRef,
  resolveEnvSecret,
  parseSecretRef,
  isSecretRef,
  secretPosture,
  type SecretRef,
} from '../../src/core/secrets/secret-ref.js';
import { redactDeep } from '../../src/core/shared/redact.js';

const ENV_KEYS = ['SR_TEST_TOKEN', 'SR_TEST_JSON', 'GATEWAY_TOKEN_REF', 'SUDO_SECRETS_REF', 'SUDO_SECRETS_ALLOW_EXEC'];

describe('SecretRef resolution', () => {
  let saved: Record<string, string | undefined>;
  let dir: string;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    dir = mkdtempSync(join(tmpdir(), 'sr-'));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  });

  it('S-1: plain string passes through verbatim (back-compat identity)', () => {
    expect(resolveSecretValue('raw-token-123')).toBe('raw-token-123');
    expect(resolveSecretValue('')).toBeNull();
    expect(resolveSecretValue(null)).toBeNull();
    expect(resolveSecretValue(undefined)).toBeNull();
  });

  it('S-2: env SecretRef resolves from process.env', () => {
    process.env['SR_TEST_TOKEN'] = 'from-env';
    const ref: SecretRef = { source: 'env', provider: 'default', id: 'SR_TEST_TOKEN' };
    expect(resolveSecretValue(ref)).toBe('from-env');
    expect(resolveSecretRef({ source: 'env', provider: 'default', id: 'MISSING_XYZ' })).toBeNull();
  });

  it('S-3: env SecretRef with #json selector', () => {
    process.env['SR_TEST_JSON'] = JSON.stringify({ api: { key: 'nested-secret' } });
    expect(resolveSecretRef({ source: 'env', provider: 'p', id: 'SR_TEST_JSON#/api/key' })).toBe('nested-secret');
    expect(resolveSecretRef({ source: 'env', provider: 'p', id: 'SR_TEST_JSON#missing' })).toBeNull();
  });

  it('S-4: file SecretRef reads an absolute path and trims trailing newline', () => {
    const f = join(dir, 'secret.txt');
    writeFileSync(f, 'file-secret\n');
    expect(resolveSecretRef({ source: 'file', provider: 'default', id: f })).toBe('file-secret');
  });

  it('S-5: file SecretRef with JSON pointer selector', () => {
    const f = join(dir, 'creds.json');
    writeFileSync(f, JSON.stringify({ token: 'json-file-secret' }));
    expect(resolveSecretRef({ source: 'file', provider: 'p', id: `${f}#token` })).toBe('json-file-secret');
  });

  it('S-6: file SecretRef rejects "." / ".." path traversal at parse', () => {
    expect(parseSecretRef({ source: 'file', provider: 'p', id: '/etc/../etc/passwd' })).toBeNull();
    expect(parseSecretRef({ source: 'file', provider: 'p', id: 'rel/../x' })).toBeNull();
  });

  it('S-7: relative file path is rejected at resolve', () => {
    expect(resolveSecretRef({ source: 'file', provider: 'p', id: 'relative/secret.txt' })).toBeNull();
  });

  it('S-8: exec SecretRef is blocked unless SUDO_SECRETS_ALLOW_EXEC=1', () => {
    const ref: SecretRef = { source: 'exec', provider: 'p', id: 'printf hello' };
    expect(resolveSecretRef(ref)).toBeNull();
    process.env['SUDO_SECRETS_ALLOW_EXEC'] = '1';
    expect(resolveSecretRef(ref)).toBe('hello');
  });

  it('S-9: SUDO_SECRETS_REF=0 disables resolution (string still passes)', () => {
    process.env['SUDO_SECRETS_REF'] = '0';
    process.env['SR_TEST_TOKEN'] = 'x';
    expect(resolveSecretRef({ source: 'env', provider: 'p', id: 'SR_TEST_TOKEN' })).toBeNull();
    expect(resolveSecretValue('still-a-string')).toBe('still-a-string');
  });

  it('S-10: parseSecretRef enforces provider/id regexes', () => {
    expect(parseSecretRef({ source: 'env', provider: 'Bad Provider', id: 'X' })).toBeNull();
    expect(parseSecretRef({ source: 'env', provider: 'ok', id: 'has space' })).toBeNull();
    expect(parseSecretRef({ source: 'nope', provider: 'ok', id: 'X' })).toBeNull();
    expect(parseSecretRef({ source: 'env', provider: 'ok', id: 'GOOD_ID' })).toEqual({ source: 'env', provider: 'ok', id: 'GOOD_ID' });
  });

  it('S-11: isSecretRef distinguishes refs from plain strings', () => {
    expect(isSecretRef({ source: 'env', provider: 'p', id: 'X' })).toBe(true);
    expect(isSecretRef('a-string')).toBe(false);
    expect(isSecretRef({ foo: 'bar' })).toBe(false);
  });
});

describe('resolveEnvSecret (gateway seam)', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('S-12: with no _REF var, returns process.env[NAME] verbatim (no-op seam)', () => {
    process.env['SR_TEST_TOKEN'] = 'plain';
    expect(resolveEnvSecret('SR_TEST_TOKEN')).toBe('plain');
    delete process.env['SR_TEST_TOKEN'];
    expect(resolveEnvSecret('SR_TEST_TOKEN')).toBeNull();
  });

  it('S-13: NAME_REF (JSON SecretRef) is resolved instead of the raw env', () => {
    process.env['SR_TEST_TOKEN'] = 'target';
    process.env['GATEWAY_TOKEN_REF'] = JSON.stringify({ source: 'env', provider: 'default', id: 'SR_TEST_TOKEN' });
    expect(resolveEnvSecret('GATEWAY_TOKEN')).toBe('target');
  });

  it('S-14: broken NAME_REF JSON fails closed (null, never falls back to open)', () => {
    process.env['GATEWAY_TOKEN'] = 'would-be-open';
    process.env['GATEWAY_TOKEN_REF'] = '{not json';
    expect(resolveEnvSecret('GATEWAY_TOKEN')).toBeNull();
  });

  it('S-15: kill-switch off → _REF ignored, raw env used', () => {
    process.env['SUDO_SECRETS_REF'] = '0';
    process.env['GATEWAY_TOKEN'] = 'raw-wins';
    process.env['GATEWAY_TOKEN_REF'] = JSON.stringify({ source: 'env', provider: 'p', id: 'SR_TEST_TOKEN' });
    expect(resolveEnvSecret('GATEWAY_TOKEN')).toBe('raw-wins');
  });
});

describe('no-raw-log posture', () => {
  it('S-16: redactDeep renders a SecretRef as posture-only (id redacted)', () => {
    const ref = { source: 'file', provider: 'vault', id: '/run/secrets/token' };
    expect(redactDeep(ref)).toEqual({ source: 'file', provider: 'vault', id: '<redacted>' });
  });

  it('S-17: secretPosture never leaks material', () => {
    expect(secretPosture({ source: 'exec', provider: 'p', id: 'aws get-secret' })).toEqual({ source: 'exec', provider: 'p' });
    expect(secretPosture('raw')).toEqual({ source: 'inline' });
  });
});
