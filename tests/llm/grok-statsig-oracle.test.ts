/**
 * @file grok-statsig-oracle.test.ts
 * @description GWV4 unit tests for the statsig oracle. NO real browser / no net /
 * no secrets: the CDP session + Playwright launcher are fakes that play back a
 * recorded chunk source, a simulated breakpoint pause, and a mocked mint. Covers:
 * the self-healing signing-site locator against a chunk fixture, a successful
 * lazy mint, re-grab after the page dropped the minter, idle auto-close, and the
 * Q-GWV escalation when the signing shape is gone.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  GrokStatsigOracle,
  GrokOracleSigningSiteError,
  locateSigningSite,
  type OracleLaunch,
  type OracleLauncher,
} from '../../src/llm/grok-statsig-oracle.js';

// A tiny minified-style chunk fixture mirroring grok's request-signing site:
//   i = new URL(u).pathname.split("?")[0]; t = await d0(i, method); headers.set("x-statsig-id", t)
const CHUNK_FIXTURE =
  'var a=1;function q(u,method,headers){let i=new URL(u).pathname.split("?")[0],' +
  't=await d0(i,method);headers.set("x-statsig-id",t);return headers}var z=2;';

const CHUNK_URL = 'https://cdn.grok.com/_next/static/chunks/0igp2fphstmjc.js';

interface FakeHandle {
  launcher: OracleLauncher;
  closed: () => boolean;
  dropMinter: () => void;
  mintCalls: () => number;
}

function makeFake(cfg: { chunkSource?: string; token?: string } = {}): FakeHandle {
  const chunkSource = cfg.chunkSource ?? CHUNK_FIXTURE;
  const token = cfg.token ?? 'T'.repeat(94);
  let closed = false;
  let minterPresent = false;
  let mintCalls = 0;
  const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  const emit = (ev: string, p: Record<string, unknown>): void => {
    for (const h of handlers.get(ev) ?? []) h(p);
  };

  const cdp = {
    on: (ev: string, h: (p: Record<string, unknown>) => void): void => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(h);
    },
    off: (ev: string, h: (p: Record<string, unknown>) => void): void => {
      handlers.get(ev)?.delete(h);
    },
    send: async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      switch (method) {
        case 'Debugger.getScriptSource':
          return { scriptSource: chunkSource };
        case 'Debugger.setBreakpointByUrl':
          return { breakpointId: 'bp1' };
        case 'Debugger.evaluateOnCallFrame':
          minterPresent = true; // hoisting __grokMint onto globalThis
          return {};
        case 'Runtime.evaluate': {
          const expr = String(params?.['expression'] ?? '');
          if (expr.includes('__grokMint(')) {
            mintCalls++;
            return minterPresent ? { result: { value: token } } : { result: {} };
          }
          return { result: {} };
        }
        default:
          return {};
      }
    },
  };

  const page = {
    goto: async (): Promise<unknown> => {
      // App boot parses the signing chunk.
      emit('Debugger.scriptParsed', { scriptId: 's1', url: CHUNK_URL });
      emit('Debugger.scriptParsed', { scriptId: 's2', url: 'https://cdn.grok.com/_next/static/chunks/other.js' });
      return null;
    },
    reload: async (): Promise<unknown> => {
      // A navigation fires a signed request → the breakpoint trips.
      emit('Debugger.paused', { callFrames: [{ callFrameId: 'cf1' }] });
      return null;
    },
    url: () => 'https://grok.com/imagine',
  };

  const context = {
    close: async (): Promise<void> => {
      closed = true;
    },
    cookies: async () => [],
  };

  const launch: OracleLaunch = {
    context: context as unknown as OracleLaunch['context'],
    page: page as unknown as OracleLaunch['page'],
    cdp: cdp as unknown as OracleLaunch['cdp'],
  };

  return {
    launcher: async () => launch,
    closed: () => closed,
    dropMinter: () => {
      minterPresent = false;
    },
    mintCalls: () => mintCalls,
  };
}

describe('locateSigningSite', () => {
  it('finds the minter name + a plausible position in a chunk fixture', () => {
    const site = locateSigningSite(CHUNK_FIXTURE);
    expect(site).not.toBeNull();
    expect(site!.minterName).toBe('d0');
    expect(site!.lineNumber).toBe(0);
    expect(site!.columnNumber).toBeGreaterThan(0);
  });

  it('returns null when the x-statsig-id / await pattern is absent', () => {
    expect(locateSigningSite('function f(){return 1}')).toBeNull();
    // marker present but no preceding await-call → still null
    expect(locateSigningSite('headers.set("x-statsig-id", token)')).toBeNull();
  });

  it('tolerates a different minified minter identifier', () => {
    const src = 'let t=await _9xZ$(p,m);h.set("x-statsig-id",t)';
    const site = locateSigningSite(src);
    expect(site!.minterName).toBe('_9xZ$');
  });
});

describe('GrokStatsigOracle', () => {
  it('mints a fresh token via a lazy headless launch (no real browser)', async () => {
    const f = makeFake();
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 0 });
    expect(oracle.health().warm).toBe(false);
    const token = await oracle.mint('/rest/app-chat/conversations/new', 'POST');
    expect(token).toHaveLength(94);
    expect(oracle.health().minterReady).toBe(true);
    await oracle.close();
  });

  it('re-grabs the minter when the page reloaded and dropped __grokMint', async () => {
    const f = makeFake();
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 0 });
    await oracle.mint('/p', 'POST');
    f.dropMinter(); // simulate a page reload that cleared globalThis.__grokMint
    const token = await oracle.mint('/p', 'POST');
    expect(token).toHaveLength(94);
    // Two eval attempts on the second mint (miss → re-grab → hit) + one on the first.
    expect(f.mintCalls()).toBeGreaterThanOrEqual(3);
    await oracle.close();
  });

  it('escalates (GrokOracleSigningSiteError) when the signing shape is gone', async () => {
    const f = makeFake({ chunkSource: 'var noSigningSiteHere=1;' });
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 0 });
    await expect(oracle.mint('/p', 'POST')).rejects.toBeInstanceOf(GrokOracleSigningSiteError);
  });

  it('throws (not launches) when no durable profile dir is configured', async () => {
    const oracle = new GrokStatsigOracle({ launcher: makeFake().launcher, idleMs: 0 });
    await expect(oracle.mint('/p', 'POST')).rejects.toThrow(/profile/i);
  });

  it('idle-closes the browser after the idle window', async () => {
    vi.useFakeTimers();
    try {
      const f = makeFake();
      const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 50 });
      await oracle.mint('/p', 'POST');
      expect(f.closed()).toBe(false);
      await vi.advanceTimersByTimeAsync(60);
      expect(f.closed()).toBe(true);
      expect(oracle.health().warm).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
