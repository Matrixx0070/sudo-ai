/**
 * @file doctor.test.ts
 * @description Unit tests for the doctor command's LLM-provider detection.
 *
 * Regression coverage for the false critical failure "Neither XAI_API_KEY nor
 * OPENAI_API_KEY is set" on installs that run on claude-oauth (Claude
 * subscription) or local ollama — those are usable providers and must NOT be
 * reported as a critical failure. Conversely, an install with NO provider at
 * all must still fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLlmProvider, type LlmProviderProbe } from './doctor.js';

const NOW = 1_800_000_000_000; // fixed clock (ms epoch)

let tmpDir: string;

function probe(overrides: Partial<LlmProviderProbe> = {}): LlmProviderProbe {
  return {
    env: {},
    oauthStorePath: path.join(tmpDir, 'claude-oauth.json'),
    configPath: path.join(tmpDir, 'sudo-ai.json5'),
    now: NOW,
    ...overrides,
  };
}

function writeOauthStore(contents: unknown): void {
  fs.writeFileSync(
    path.join(tmpDir, 'claude-oauth.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
    'utf8',
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectLlmProvider', () => {
  it('passes with XAI_API_KEY', () => {
    const res = detectLlmProvider(probe({ env: { XAI_API_KEY: 'xai-abc' } }));
    expect(res.level).toBe('ok');
    expect(res.message).toContain('XAI_API_KEY');
  });

  it('passes with OPENAI_API_KEY', () => {
    const res = detectLlmProvider(probe({ env: { OPENAI_API_KEY: 'sk-abc' } }));
    expect(res.level).toBe('ok');
    expect(res.message).toContain('OPENAI_API_KEY');
  });

  it('passes with ANTHROPIC_API_KEY', () => {
    const res = detectLlmProvider(probe({ env: { ANTHROPIC_API_KEY: 'sk-ant' } }));
    expect(res.level).toBe('ok');
    expect(res.message).toContain('ANTHROPIC key');
  });

  it('passes with a claude-oauth store holding an unexpired access token', () => {
    writeOauthStore({
      accessToken: 'at-123',
      refreshToken: 'rt-123',
      expiresAt: NOW + 60_000,
      scopes: ['user:inference'],
    });
    const res = detectLlmProvider(probe());
    expect(res.level).toBe('ok');
    expect(res.message).toContain('claude-oauth (token valid)');
  });

  it('passes with an EXPIRED access token when a refresh token is present (boot refreshes it)', () => {
    writeOauthStore({
      accessToken: 'at-123',
      refreshToken: 'rt-123',
      expiresAt: NOW - 60_000,
      scopes: ['user:inference'],
    });
    const res = detectLlmProvider(probe());
    expect(res.level).toBe('ok');
    expect(res.message).toContain('claude-oauth (refresh token)');
  });

  it('fails with an expired token and NO refresh token', () => {
    writeOauthStore({ accessToken: 'at-123', expiresAt: NOW - 60_000 });
    const res = detectLlmProvider(probe());
    expect(res.level).toBe('error');
  });

  it('fails on a corrupt claude-oauth store (invalid JSON)', () => {
    writeOauthStore('{not json');
    const res = detectLlmProvider(probe());
    expect(res.level).toBe('error');
  });

  it('passes with OLLAMA_URL set', () => {
    const res = detectLlmProvider(probe({ env: { OLLAMA_URL: 'http://127.0.0.1:11434' } }));
    expect(res.level).toBe('ok');
    expect(res.message).toContain('ollama (http://127.0.0.1:11434)');
  });

  it('fails with NO provider at all (empty env, no oauth store)', () => {
    const res = detectLlmProvider(probe());
    expect(res.level).toBe('error');
    expect(res.message).toContain('No LLM provider');
  });

  it('fails with a claude-oauth/* model chain in config but no stored token — with a login hint', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'sudo-ai.json5'),
      '{ agent: { model: "claude-oauth/claude-opus-4-8" } }',
      'utf8',
    );
    const res = detectLlmProvider(probe());
    expect(res.level).toBe('error');
    expect(res.message).toContain('sudo-ai claude-oauth login');
  });

  it('treats empty-string env values as unset', () => {
    const res = detectLlmProvider(probe({ env: { XAI_API_KEY: '', OPENAI_API_KEY: '' } }));
    expect(res.level).toBe('error');
  });

  it('lists multiple providers when several are available', () => {
    writeOauthStore({ accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 60_000 });
    const res = detectLlmProvider(probe({
      env: { OPENAI_API_KEY: 'sk-abc', OLLAMA_URL: 'http://localhost:11434' },
    }));
    expect(res.level).toBe('ok');
    expect(res.message).toContain('OPENAI_API_KEY');
    expect(res.message).toContain('claude-oauth');
    expect(res.message).toContain('ollama');
  });
});

describe('closeLogger', () => {
  it('resolves (no-op under vitest, where no worker transport exists) and is idempotent', async () => {
    const { closeLogger } = await import('../../core/shared/logger.js');
    await expect(closeLogger()).resolves.toBeUndefined();
    await expect(closeLogger()).resolves.toBeUndefined();
  });
});
