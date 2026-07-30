/**
 * @file veto-fail-posture.test.ts
 * @description Risk-tiered VetoGate failure posture (invariant 8). When
 * queryAllModels throws (total model outage — live-observed 2026-07-30 during
 * the Anthropic org block), the old blanket fail-open APPROVED even HIGH-risk
 * calls with zero review. Now: MEDIUM keeps the deliberate fail-open
 * (availability); HIGH/CRITICAL fail CLOSED (VETO). SUDO_VETO_FAILOPEN_HIGH=1
 * restores the blanket fail-open.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { runVetoGate } from '../../src/core/agent/veto-gate.js';

const throwingFetcher = async (): Promise<string> => {
  throw new Error('All models failed — no answers received');
};

afterEach(() => { delete process.env['SUDO_VETO_FAILOPEN_HIGH']; });

describe('VetoGate failure posture on total model outage', () => {
  it('POSTURE-1: HIGH risk fails CLOSED (VETO, not failedOpen)', async () => {
    // writeConfig matches HIGH_TOOL_RE (/write|.../).
    const result = await runVetoGate({ toolName: 'writeConfig', args: { path: '/etc/x' } }, throwingFetcher);
    expect(['HIGH', 'CRITICAL']).toContain(result.risk);
    expect(result.decision).toBe('VETO');
    expect(result.failedOpen).toBeUndefined(); // marker reserved for audited fail-open
  });

  it('POSTURE-2: MEDIUM risk keeps the deliberate fail-open (APPROVE, audited)', async () => {
    // read-like tool with large limit → MEDIUM.
    const result = await runVetoGate({ toolName: 'searchRecords', args: { limit: 5000 } }, throwingFetcher);
    expect(result.risk).toBe('MEDIUM');
    expect(result.decision).toBe('APPROVE');
    expect(result.failedOpen).toBe(true);
  });

  it('POSTURE-3: SUDO_VETO_FAILOPEN_HIGH=1 restores blanket fail-open', async () => {
    process.env['SUDO_VETO_FAILOPEN_HIGH'] = '1';
    const result = await runVetoGate({ toolName: 'writeConfig', args: { path: '/etc/x' } }, throwingFetcher);
    expect(result.decision).toBe('APPROVE');
    expect(result.failedOpen).toBe(true);
  });

  it('POSTURE-4: LOW risk never consults models — unaffected by outage', async () => {
    const result = await runVetoGate({ toolName: 'clock', args: {} }, throwingFetcher);
    expect(result.decision).toBe('APPROVE');
    expect(result.failedOpen).toBeUndefined();
  });
});
