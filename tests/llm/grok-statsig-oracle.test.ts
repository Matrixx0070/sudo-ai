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
  /** How many times the breakpoint dance ran — 0 proves the minter was adopted. */
  exposeCount: () => number;
  minterPresent: () => boolean;
}

function makeFake(
  cfg: {
    chunkSource?: string;
    token?: string;
    /** Page already carries `__grokMint` from an earlier oracle instance. */
    preHoisted?: boolean;
    /**
     * Which execution context can see the minter. `'default'` means only an
     * un-pinned eval finds it — that reproduces the stale-pin bug, where the
     * minter is alive but the PINNED context reports it absent.
     */
    minterCtx?: number | 'default';
    /**
     * `__grokMint` exists but yields nothing — a closure left over from a
     * navigated page. `typeof` still says "function".
     */
    mintReturnsNull?: boolean;
  } = {},
): FakeHandle {
  const chunkSource = cfg.chunkSource ?? CHUNK_FIXTURE;
  const token = cfg.token ?? 'T'.repeat(94);
  let closed = false;
  let minterPresent = cfg.preHoisted === true;
  let mintCalls = 0;
  let exposeCount = 0;
  let deadClosure = cfg.mintReturnsNull === true;
  const visibleIn = (ctx: unknown): boolean => {
    if (cfg.minterCtx === undefined) return true;
    if (cfg.minterCtx === 'default') return ctx === undefined;
    return ctx === cfg.minterCtx;
  };
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
          exposeCount++;
          return { breakpointId: 'bp1' };
        case 'Debugger.evaluateOnCallFrame':
          minterPresent = true; // hoisting __grokMint onto globalThis
          deadClosure = false; // a fresh hoist replaces any stale closure
          return {};
        case 'Runtime.evaluate': {
          const expr = String(params?.['expression'] ?? '');
          const ctx = params?.['contextId'];
          if (expr.includes('delete globalThis.__grokMint')) {
            minterPresent = false;
            return {};
          }
          if (expr.includes('__grokMint(')) {
            mintCalls++;
            return minterPresent && visibleIn(ctx) && !deadClosure
              ? { result: { value: token } }
              : { result: { type: 'undefined' } };
          }
          if (expr.includes("typeof globalThis.__grokMint")) {
            return { result: { value: minterPresent && visibleIn(ctx) } };
          }
          if (expr.includes('readyState')) {
            return { result: { value: 'complete|1' } };
          }
          return { result: {} };
        }
        default:
          return {};
      }
    },
  };

  const drive = (): void => {
    // App boot parses the signing chunk (with an execution context id) ...
    emit('Debugger.scriptParsed', { scriptId: 's1', url: CHUNK_URL, executionContextId: 100 });
    emit('Debugger.scriptParsed', {
      scriptId: 's2',
      url: 'https://cdn.grok.com/_next/static/chunks/other.js',
      executionContextId: 100,
    });
    // ... and a signed request trips the breakpoint in the signing chunk's frame.
    emit('Debugger.paused', { callFrames: [{ callFrameId: 'cf1', location: { scriptId: 's1' } }] });
  };
  const page = {
    // The oracle uses goto both to load the app AND to trigger the breakpoint.
    goto: async (): Promise<unknown> => {
      drive();
      return null;
    },
    reload: async (): Promise<unknown> => {
      drive();
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
    exposeCount: () => exposeCount,
    minterPresent: () => minterPresent,
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
    // Miss is detected via a `typeof __grokMint` probe (not a wasted mint call),
    // so each of the two mints makes exactly one minter call; success after the
    // drop proves the re-grab happened.
    expect(f.mintCalls()).toBeGreaterThanOrEqual(2);
    await oracle.close();
  });

  it('escalates (GrokOracleSigningSiteError) when the signing shape is gone', async () => {
    const f = makeFake({ chunkSource: 'var noSigningSiteHere=1;' });
    // breakpointTimeoutMs bounds the signing-chunk poll; keep it short so the
    // "shape is gone" escalation resolves fast instead of polling the default 20s.
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 0, breakpointTimeoutMs: 200 });
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

describe('minter adoption (cold-path latency)', () => {
  it('adopts an already-hoisted minter instead of re-running the breakpoint dance', async () => {
    // The page outlives the oracle: in CDP-connect mode close() drops only our
    // socket, so __grokMint survives the idle window. Measured live, rebuilding
    // it cost ~13s per cold call for nothing.
    const f = makeFake({ preHoisted: true });
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 0 });
    const tok = await oracle.mint('/rest/app-chat/conversations/new', 'POST');
    expect(tok).toHaveLength(94);
    expect(f.exposeCount()).toBe(0);
  });

  it('falls back to the full expose when the page has no minter', async () => {
    const f = makeFake();
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 0 });
    expect(await oracle.mint('/p', 'POST')).toHaveLength(94);
    expect(f.exposeCount()).toBeGreaterThan(0);
  });

  it('does not adopt a minter that returns nothing', async () => {
    // A stale closure on a navigated page is still a function but mints null.
    // Adopting on `typeof` alone would trade a slow path for a broken one.
    const f = makeFake({ preHoisted: true, mintReturnsNull: true });
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 0 });
    expect(await oracle.mint('/p', 'POST')).toHaveLength(94);
    expect(f.exposeCount()).toBeGreaterThan(0);
  });

  it('treats a stale PINNED context as present, not absent', async () => {
    // The real bug: the trigger navigation replaces the document, so the pinned
    // context is dead while the minter is fine. Reporting "absent" threw away a
    // warm oracle and re-exposed — 13s, measured.
    const f = makeFake({ preHoisted: true, minterCtx: 'default' });
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 0 });
    (oracle as unknown as { mintCtxId: number }).mintCtxId = 999; // a context that no longer exists
    await oracle.mint('/p', 'POST');
    expect(f.exposeCount()).toBe(0);
  });
});

describe('invalidateMinter (drift self-heal)', () => {
  it('deletes the in-page minter so the next mint rebuilds it', async () => {
    // Adoption proves a minter RETURNS a token, never that the server ACCEPTS
    // it. Without this the lane would wedge on a drifted seed with no recovery.
    const f = makeFake({ preHoisted: true });
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: f.launcher, idleMs: 0 });
    await oracle.mint('/p', 'POST');
    expect(f.exposeCount()).toBe(0);

    await oracle.invalidateMinter();
    expect(f.minterPresent()).toBe(false);

    expect(await oracle.mint('/p', 'POST')).toHaveLength(94);
    expect(f.exposeCount()).toBeGreaterThan(0);
  });

  it('is safe before anything launched', async () => {
    const oracle = new GrokStatsigOracle({ profileDir: '/prof', launcher: makeFake().launcher, idleMs: 0 });
    await expect(oracle.invalidateMinter()).resolves.toBeUndefined();
  });
});
