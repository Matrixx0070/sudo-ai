/**
 * Statsig algorithm-drift canary: classifies healthy vs algorithm_drift vs
 * session_issue vs error from pure-Node-token + oracle-token gate probes.
 */

import { describe, it, expect, vi } from 'vitest';
import { checkStatsigDrift, type GateProbe } from '../../src/llm/grok-statsig-drift-canary.js';

const deps = (over: Partial<Parameters<typeof checkStatsigDrift>[0]>) => ({
  mintPureNode: vi.fn(async () => 'PN'.padEnd(94, 'x')),
  mintOracle: vi.fn(async () => 'OR'.padEnd(94, 'x')),
  probeGate: vi.fn(async (): Promise<GateProbe> => ({ passed: true, status: 200 })),
  ...over,
});

describe('checkStatsigDrift', () => {
  it('healthy: pure-Node token passes the gate', async () => {
    const d = deps({});
    const r = await checkStatsigDrift(d);
    expect(r.status).toBe('healthy');
    expect(d.mintOracle).not.toHaveBeenCalled(); // no need to check the oracle
  });

  it('algorithm_drift: pure-Node anti-bot-rejected but oracle passes', async () => {
    const probeGate = vi
      .fn<[string], Promise<GateProbe>>()
      .mockResolvedValueOnce({ passed: false, status: 403, errorClass: 'statsig' }) // pure-Node
      .mockResolvedValueOnce({ passed: true, status: 200 }); // oracle
    const r = await checkStatsigDrift(deps({ probeGate }));
    expect(r.status).toBe('algorithm_drift');
    expect(r.detail).toMatch(/scope-walk recovery/);
  });

  it('session_issue: both pure-Node and oracle rejected', async () => {
    const probeGate = vi
      .fn<[string], Promise<GateProbe>>()
      .mockResolvedValue({ passed: false, status: 403, errorClass: 'statsig' });
    const r = await checkStatsigDrift(deps({ probeGate }));
    expect(r.status).toBe('session_issue');
    expect(r.detail).toMatch(/session\/cloudflare/i);
  });

  it('session_issue: pure-Node fails with a non-anti-bot error (no drift, no oracle check)', async () => {
    const probeGate = vi.fn(async (): Promise<GateProbe> => ({ passed: false, status: 500, errorClass: 'http_error' }));
    const d = deps({ probeGate });
    const r = await checkStatsigDrift(d);
    expect(r.status).toBe('session_issue');
    expect(d.mintOracle).not.toHaveBeenCalled();
  });

  it('error: an unexpected throw is captured, not propagated', async () => {
    const r = await checkStatsigDrift(
      deps({
        mintPureNode: vi.fn(async () => {
          throw new Error('mint boom');
        }),
      }),
    );
    expect(r.status).toBe('error');
    expect(r.detail).toMatch(/mint boom/);
  });
});
