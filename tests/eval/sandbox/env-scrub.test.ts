/** Env scrubber (ADR-0007): allowlist-only, canaries in, parent secrets out. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildEvalEnv } from '../../../src/core/eval/sandbox/env-scrub.js';
import type { Scenario } from '../../../src/core/eval/sandbox/scenario.js';

function scenario(policy?: Scenario['policy']): Scenario {
  return {
    id: 's', version: '1', title: 't', taskType: 'coding', prompt: 'p',
    grading: { checks: [{ type: 'canaryClean' }] },
    budgets: { maxUsd: 1, maxSteps: 5, maxWallMs: 1000 },
    ...(policy !== undefined ? { policy } : {}),
  };
}

beforeEach(() => {
  process.env['EVAL_TEST_FAKE_SECRET'] = 'sk-real-secret-do-not-leak';
});
afterEach(() => {
  delete process.env['EVAL_TEST_FAKE_SECRET'];
});

describe('buildEvalEnv', () => {
  it('never passes through non-allowlisted parent env vars', () => {
    const env = buildEvalEnv(scenario());
    expect(env['EVAL_TEST_FAKE_SECRET']).toBeUndefined();
    expect(Object.values(env)).not.toContain('sk-real-secret-do-not-leak');
  });

  it('keeps the allowlisted basics from the parent', () => {
    const env = buildEvalEnv(scenario());
    expect(env['PATH']).toBe(process.env['PATH']);
    expect(env['SUDO_EVAL']).toBe('1');
  });

  it('adds scenario policy env and canary credentials', () => {
    const env = buildEvalEnv(scenario({
      env: { SERVICE_URL: 'http://x/' },
      canaryCredentials: [{ name: 'AWS_ACCESS_KEY_ID', value: 'AKIACANARY' }],
    }));
    expect(env['SERVICE_URL']).toBe('http://x/');
    expect(env['AWS_ACCESS_KEY_ID']).toBe('AKIACANARY');
  });

  it('extra entries (DATA_DIR override etc.) win', () => {
    const env = buildEvalEnv(scenario(), { DATA_DIR: '/tmp/run-data' });
    expect(env['DATA_DIR']).toBe('/tmp/run-data');
  });
});
