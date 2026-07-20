/**
 * @file tests/llm/xai-apikey-manager.test.ts
 * @description GP3 — the independent `xai` API-key credential store. All I/O is
 * against a tmp file; the API key value is never asserted into logs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XaiApiKeyManager } from '../../src/llm/xai-apikey-manager.js';
import type { XaiModelEntry } from '../../src/llm/xai-models.js';

const MODELS: XaiModelEntry[] = [
  { id: 'grok-4-fast', name: 'grok-4-fast', contextWindow: null, backend: null, supportsReasoningEffort: false, reasoningEfforts: [], aliases: [], billing: 'metered' },
];

let dir: string;
let storePath: string;
const savedEnv = process.env['XAI_API_KEY'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xai-apikey-'));
  storePath = join(dir, 'xai-apikey.json');
  delete process.env['XAI_API_KEY'];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env['XAI_API_KEY'];
  else process.env['XAI_API_KEY'] = savedEnv;
});

describe('XaiApiKeyManager — key persistence + independence', () => {
  it('persists the key 0600 and reads it back (store beats env)', () => {
    const m = new XaiApiKeyManager(storePath);
    m.setApiKey('  xai-secret-key  ');
    expect(existsSync(storePath)).toBe(true);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    process.env['XAI_API_KEY'] = 'env-key';
    expect(m.getApiKey()).toBe('xai-secret-key'); // store wins, trimmed
  });

  it('falls back to XAI_API_KEY env when the store is empty', () => {
    const m = new XaiApiKeyManager(storePath);
    expect(m.getApiKey()).toBeNull();
    process.env['XAI_API_KEY'] = 'env-key';
    expect(m.getApiKey()).toBe('env-key');
    expect(m.status()).toMatchObject({ connected: true, source: 'env' });
  });

  it('rejects an empty key', () => {
    const m = new XaiApiKeyManager(storePath);
    expect(() => m.setApiKey('   ')).toThrow(/non-empty/);
  });

  it('disconnect wipes the store but not the env key', () => {
    const m = new XaiApiKeyManager(storePath);
    m.setApiKey('k');
    process.env['XAI_API_KEY'] = 'env-key';
    m.disconnect();
    expect(existsSync(storePath)).toBe(false);
    expect(m.getApiKey()).toBe('env-key'); // env survives
  });

  it('does not touch any oauth store path', () => {
    const m = new XaiApiKeyManager(storePath);
    m.setApiKey('k');
    // Only the apikey file exists in the tmp dir.
    const oauthPath = join(dir, 'xai-oauth.json');
    expect(existsSync(oauthPath)).toBe(false);
  });
});

describe('XaiApiKeyManager — model cache + default', () => {
  it('caches models and resolves default (picked, else first, else null)', () => {
    const m = new XaiApiKeyManager(storePath);
    m.setApiKey('k');
    expect(m.getDefaultModel()).toBeNull(); // no models yet
    m.setModels(MODELS);
    expect(m.getDefaultModel()).toBe('grok-4-fast'); // first cached
    expect(m.setDefaultModel('grok-4-fast')).toBe(true);
    expect(m.getDefaultModel()).toBe('grok-4-fast');
    // picker state survives a re-instantiation (persisted)
    const m2 = new XaiApiKeyManager(storePath);
    expect(m2.getDefaultModel()).toBe('grok-4-fast');
    expect(m2.listModels()).toHaveLength(1);
  });

  it('rejects set-default for an id not in the cached list', () => {
    const m = new XaiApiKeyManager(storePath);
    m.setApiKey('k');
    m.setModels(MODELS);
    expect(m.setDefaultModel('grok-nonexistent')).toBe(false);
  });

  it('setModels persists a fetch timestamp', () => {
    const m = new XaiApiKeyManager(storePath, () => 12345);
    m.setApiKey('k');
    m.setModels(MODELS);
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(raw.modelsFetchedAt).toBe(12345);
  });
});
