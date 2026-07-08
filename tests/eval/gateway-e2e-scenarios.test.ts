/**
 * @file tests/eval/gateway-e2e-scenarios.test.ts
 * @description CI-safe unit coverage for the gateway E2E harness — validates
 *   the scenario files parse into the expected shape and the free-port helper
 *   works. Does NOT spawn a daemon (that runs only via SUDO_E2E=1 pnpm
 *   e2e:gateway, never in unit CI).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadScenarios, freePort } from '../../src/core/eval/gateway-e2e/runner.js';

const SCENARIO_DIR = join(process.cwd(), 'src/core/eval/gateway-e2e/scenarios');

describe('gateway-e2e scenarios', () => {
  it('has at least one scenario file', () => {
    expect(readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.yaml')).length).toBeGreaterThan(0);
  });

  it('every scenario parses with required fields and compilable regexes', () => {
    for (const s of loadScenarios(SCENARIO_DIR)) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.message).toBe('string');
      expect(typeof s.peerId).toBe('string');
      for (const key of ['expect_reply_regex', 'expect_reply2_regex', 'expect_cron_job_regex'] as const) {
        const v = s[key];
        if (v !== undefined) expect(() => new RegExp(String(v))).not.toThrow();
      }
      if (s.timeout_ms !== undefined) expect(typeof s.timeout_ms).toBe('number');
    }
  });

  it('freePort returns a usable ephemeral port', async () => {
    const p = await freePort();
    expect(p).toBeGreaterThan(1023);
    expect(p).toBeLessThan(65536);
  });
});
