/** Scenario manifest validator (ADR-0007 Phase 0). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateScenario, loadScenarioFile } from '../../../src/core/eval/sandbox/scenario.js';

// vitest runs with cwd = repo root (same convention as tests/gdrive/hot-path.test.ts)
const SCENARIOS_DIR = path.resolve('evals/sandbox/scenarios');

function valid(): Record<string, unknown> {
  return {
    id: 't1',
    version: '1',
    title: 'test',
    taskType: 'coding',
    prompt: 'do the thing',
    grading: { checks: [{ type: 'fileExists', path: 'out.txt' }] },
    budgets: { maxUsd: 0.5, maxSteps: 10, maxWallMs: 60000 },
  };
}

describe('validateScenario', () => {
  it('accepts a minimal valid manifest', () => {
    const v = validateScenario(valid());
    expect(v.ok).toBe(true);
  });

  it('accepts the full field set including isolation + canaries + mockService', () => {
    const v = validateScenario({
      ...valid(),
      fixtures: [{ path: 'a.txt', content: 'x' }],
      policy: {
        tools: { allow: ['coder.*'], deny: ['system.exec'] },
        egressAllowlist: ['example.com'],
        env: { FOO: 'bar' },
        canaryCredentials: [{ name: 'AWS_KEY', value: 'AKIA123' }],
      },
      persistentMemory: '/tmp/snapshot.db',
      isolation: 'runsc',
      mockService: { failuresBeforeSuccess: 2, successBody: 'ok' },
    });
    expect(v.ok).toBe(true);
  });

  it('rejects a missing required field', () => {
    const raw = valid();
    delete raw['prompt'];
    const v = validateScenario(raw);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.length).toBeGreaterThan(0);
  });

  it('rejects an unknown taskType', () => {
    expect(validateScenario({ ...valid(), taskType: 'nuclear' }).ok).toBe(false);
  });

  it('rejects unknown top-level properties (strict)', () => {
    expect(validateScenario({ ...valid(), surprise: true }).ok).toBe(false);
  });

  it('rejects an unknown check type', () => {
    const raw = valid();
    (raw['grading'] as { checks: unknown[] }).checks = [{ type: 'llmJudge' }];
    expect(validateScenario(raw).ok).toBe(false);
  });

  it('rejects an invalid isolation value', () => {
    expect(validateScenario({ ...valid(), isolation: 'kvm' }).ok).toBe(false);
  });
});

describe('seed scenarios', () => {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.yaml'));

  it('ships the 5 Phase-1 seed scenarios', () => {
    expect(files.sort()).toEqual([
      'coding-task.yaml',
      'credential-canary.yaml',
      'recovery-drill.yaml',
      'restricted-resource.yaml',
      'unreliable-service.yaml',
    ]);
  });

  for (const f of files) {
    it(`${f} passes strict validation`, () => {
      const s = loadScenarioFile(path.join(SCENARIOS_DIR, f));
      expect(s.id).toBe(f.replace(/\.yaml$/, ''));
      expect(s.grading.checks.length).toBeGreaterThan(0);
    });
  }
});
