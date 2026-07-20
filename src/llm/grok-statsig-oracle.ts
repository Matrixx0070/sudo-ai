/**
 * @file grok-statsig-oracle.ts
 * @description GWV1 — the "statsig oracle": an on-demand, headless grok.com page
 * that exposes grok's own request-signing minter and serves fresh `x-statsig-id`
 * tokens for the video lane (`POST /rest/app-chat/conversations/new`).
 *
 * WHY A BROWSER (path B / pure-Node is DEAD): the video endpoint's `x-statsig-id`
 * is minted by grok's client code and folds the browser rendering/animation
 * engine output into the signature (`createElement → animate → getComputedStyle`
 * over a rotating page seed). It CANNOT be reproduced in Node/jsdom — a real
 * (headless is fine) rendering engine must mint it. See
 * docs/OPUS_HANDOFF_GROK_VIDEO_ORACLE.md §1.
 *
 * MECHANISM (Fable-proven live): via CDP, set a Debugger breakpoint at the
 * request-signing site (`t = await d0(path, method)` just before
 * `headers.set("x-statsig-id", t)` in the main app chunk), trigger a signed
 * request, and on pause `Debugger.evaluateOnCallFrame` to hoist the in-scope
 * minter fn onto `globalThis.__grokMint`. Then `Runtime.evaluate`
 * `globalThis.__grokMint(path, method)` mints a fresh 94-char token in <1s using
 * the live page's render fingerprint + current seed. Mint fresh per request; the
 * ~20–45s TTL is then irrelevant. Never replay, never store a token.
 *
 * SELF-HEALING: chunk names/offsets change on any grok redeploy, so the signing
 * site is located at RUNTIME by searching the loaded chunk source for the stable
 * `x-statsig-id` string + the adjacent `await <minter>(` call (see
 * `locateSigningSite`). If the shape is gone, we throw
 * `GrokOracleSigningSiteError` for a `Q-GWV` escalation rather than guessing.
 *
 * LIFECYCLE: launch lazily on first mint; keep warm only for an idle window
 * (`SUDO_GROK_ORACLE_IDLE_MS`, default 120000ms) then close. Never a
 * permanently-open browser.
 *
 * SECRETS: the minted token, cookies, and page seed are NEVER logged — lengths /
 * booleans / durations only.
 */

import { chromium, type BrowserContext, type Page, type CDPSession } from 'playwright-core';
import {
  buildLaunchArgs,
  resolveChromeExecutable,
  resolveBrowserDisplay,
} from '../core/tools/builtin/browser/anti-detect.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:grok-statsig-oracle');

/** Page that loads the minter + a live seed. */
const DEFAULT_NAVIGATE_URL = 'https://grok.com/imagine';
/** Default warm-idle window before the oracle closes its browser. */
const DEFAULT_IDLE_MS = 120_000;
/** Stable string present at the request-signing site across redeploys. */
const STATSIG_MARKER = 'x-statsig-id';
/** How far back from the marker to look for the `await <minter>(` call. */
const BACKSCAN_WINDOW = 600;
/** Only these script URLs are candidates for the signing site. */
const CHUNK_URL_RE = /_next\/static\/chunks\//;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The signing-site shape changed (grok redeploy) — escalate Q-GWV, do not guess. */
export class GrokOracleSigningSiteError extends Error {
  readonly code = 'GROK_ORACLE_SIGNING_SITE_NOT_FOUND';
  constructor(detail = '') {
    super(
      `Grok statsig oracle could not locate the request-signing site (the '${STATSIG_MARKER}' + ` +
        `'await <minter>(' pattern). Grok likely changed the signing shape — escalate Q-GWV.` +
        (detail ? ` (${detail})` : ''),
    );
    this.name = 'GrokOracleSigningSiteError';
  }
}

/** A mint attempt failed (minter threw / returned non-string / eval error). */
export class GrokOracleMintError extends Error {
  readonly code = 'GROK_ORACLE_MINT_FAILED';
  constructor(detail = '') {
    super(`Grok statsig oracle failed to mint a token${detail ? `: ${detail}` : ''}.`);
    this.name = 'GrokOracleMintError';
  }
}

// ---------------------------------------------------------------------------
// Self-healing signing-site locator (pure — unit-tested against a chunk fixture)
// ---------------------------------------------------------------------------

export interface SigningSite {
  /** 0-based line of the `await <minter>(` call (for Debugger.setBreakpointByUrl). */
  lineNumber: number;
  /** 0-based column of the `await` keyword within its line. */
  columnNumber: number;
  /** The in-scope minter identifier (e.g. `d0`) to hoist onto globalThis. */
  minterName: string;
}

function offsetToLineCol(src: string, offset: number): { lineNumber: number; columnNumber: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (src.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { lineNumber: line, columnNumber: offset - lineStart };
}

/**
 * Locate the request-signing site in a loaded app-chunk source by searching for
 * the stable `x-statsig-id` string and the nearest preceding `await <minter>(`
 * call. Returns null if the pattern is absent (caller escalates Q-GWV).
 *
 * Robust to minification (single-line chunks, arbitrary identifiers) because it
 * keys on the two stable tokens, not on chunk names or byte offsets.
 */
export function locateSigningSite(source: string): SigningSite | null {
  const awaitRe = /await\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let markerIdx = source.indexOf(STATSIG_MARKER);
  while (markerIdx !== -1) {
    const windowStart = Math.max(0, markerIdx - BACKSCAN_WINDOW);
    const back = source.slice(windowStart, markerIdx);
    awaitRe.lastIndex = 0;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = awaitRe.exec(back)) !== null) last = m;
    if (last) {
      const offset = windowStart + last.index;
      const { lineNumber, columnNumber } = offsetToLineCol(source, offset);
      return { lineNumber, columnNumber, minterName: last[1]! };
    }
    markerIdx = source.indexOf(STATSIG_MARKER, markerIdx + STATSIG_MARKER.length);
  }
  return null;
}

// ---------------------------------------------------------------------------
// CDP / browser seams (mocked in tests — no real browser in CI)
// ---------------------------------------------------------------------------

/** Minimal CDP surface the oracle uses — a subset of Playwright's CDPSession. */
export interface OracleCdp {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  off(event: string, handler: (params: Record<string, unknown>) => void): void;
}

/** Minimal page surface. */
export interface OraclePage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload(opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
}

/** Minimal context surface. */
export interface OracleContext {
  close(): Promise<void>;
  cookies(url?: string): Promise<Array<{ name: string; value: string; domain: string }>>;
}

export interface OracleLaunch {
  context: OracleContext;
  page: OraclePage;
  cdp: OracleCdp;
}

/** Injectable launcher — real Playwright by default, faked in tests. */
export type OracleLauncher = (profileDir: string) => Promise<OracleLaunch>;

/**
 * Real Playwright launcher: a headless persistent-context Chrome on the durable
 * grok profile (SSO logged-in) with a CDP session bound to its first page. Same
 * host as the curl_cffi bridge (cf_clearance is IP-bound). Nothing is held open
 * beyond the oracle's idle window.
 */
export function makeRealOracleLauncher(): OracleLauncher {
  return async (profileDir: string): Promise<OracleLaunch> => {
    const executablePath = resolveChromeExecutable() ?? undefined;
    if (!process.env['DISPLAY']) process.env['DISPLAY'] = resolveBrowserDisplay();
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      executablePath,
      args: buildLaunchArgs(),
      viewport: { width: 1280, height: 800 },
      // Strict TLS by default (a forged cert must not feed us a bogus session/seed).
      ignoreHTTPSErrors: process.env['SUDO_GROK_WEB_INSECURE_TLS'] === '1',
    });
    context.on('dialog', (d) => {
      d.dismiss().catch(() => {});
    });
    const page: Page = context.pages()[0] ?? (await context.newPage());
    const session: CDPSession = await context.newCDPSession(page);
    return {
      context: context as unknown as OracleContext,
      page: page as unknown as OraclePage,
      cdp: {
        send: (method, params) =>
          session.send(method as Parameters<CDPSession['send']>[0], params as never) as Promise<
            Record<string, unknown>
          >,
        on: (event, handler) => session.on(event as never, handler as never),
        off: (event, handler) => session.off(event as never, handler as never),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

export interface GrokStatsigOracleOptions {
  /** Durable grok profile dir (SSO logged-in). Required to launch. */
  profileDir?: string;
  launcher?: OracleLauncher;
  /** Idle window before auto-close (ms). Env SUDO_GROK_ORACLE_IDLE_MS wins if set. */
  idleMs?: number;
  /** Page that loads the minter + seed. */
  navigateUrl?: string;
  /** Max wall time to wait for the breakpoint to trip (ms). */
  breakpointTimeoutMs?: number;
  now?: () => number;
}

export interface GrokOracleHealth {
  warm: boolean;
  minterReady: boolean;
  idleMs: number;
}

function resolveIdleMs(opt?: number): number {
  const env = process.env['SUDO_GROK_ORACLE_IDLE_MS'];
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return opt ?? DEFAULT_IDLE_MS;
}

export class GrokStatsigOracle {
  private launch: OracleLaunch | null = null;
  private minterReady = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly launcher: OracleLauncher;
  private readonly idleMs: number;
  private readonly navigateUrl: string;
  private readonly breakpointTimeoutMs: number;
  private readonly profileDir?: string;
  private readonly now: () => number;
  /** Single-flight warm — concurrent minters share one launch+grab. */
  private warming: Promise<void> | null = null;

  constructor(opts: GrokStatsigOracleOptions = {}) {
    this.launcher = opts.launcher ?? makeRealOracleLauncher();
    this.idleMs = resolveIdleMs(opts.idleMs);
    this.navigateUrl = opts.navigateUrl ?? DEFAULT_NAVIGATE_URL;
    this.breakpointTimeoutMs = opts.breakpointTimeoutMs ?? 20_000;
    if (opts.profileDir !== undefined) this.profileDir = opts.profileDir;
    this.now = opts.now ?? (() => Date.now());
  }

  health(): GrokOracleHealth {
    return { warm: this.launch !== null, minterReady: this.minterReady, idleMs: this.idleMs };
  }

  /** Ensure a launched page with the minter hoisted. Idempotent, single-flight. */
  async warm(): Promise<void> {
    if (this.launch && this.minterReady) {
      this.touch();
      return;
    }
    if (!this.warming) {
      this.warming = this.doWarm().finally(() => {
        this.warming = null;
      });
    }
    await this.warming;
    this.touch();
  }

  private async doWarm(): Promise<void> {
    if (!this.profileDir) {
      throw new Error(
        'Grok statsig oracle has no durable profile dir — run `sudo-ai grok websession setup` first.',
      );
    }
    if (!this.launch) {
      const t0 = this.now();
      this.launch = await this.launcher(this.profileDir);
      log.info({ launchMs: this.now() - t0 }, 'grok statsig oracle launched (headless)');
    }
    await this.exposeMinter(this.launch);
  }

  /**
   * Locate the signing site in the loaded chunks, breakpoint it, trigger a signed
   * request, and hoist the in-scope minter onto `globalThis.__grokMint`.
   */
  private async exposeMinter(launch: OracleLaunch): Promise<void> {
    const { cdp, page } = launch;
    const scripts = new Map<string, string>(); // scriptId -> url

    const onParsed = (p: Record<string, unknown>): void => {
      const id = p['scriptId'];
      const url = p['url'];
      if (typeof id === 'string' && typeof url === 'string' && CHUNK_URL_RE.test(url)) {
        scripts.set(id, url);
      }
    };
    cdp.on('Debugger.scriptParsed', onParsed);
    await cdp.send('Debugger.enable');
    await cdp.send('Runtime.enable');

    // Load the app so its chunks (incl. the signing chunk) parse.
    await page.goto(this.navigateUrl, { waitUntil: 'domcontentloaded', timeout: this.breakpointTimeoutMs }).catch(() => {});

    // Find the signing site among the parsed chunks.
    let found: { url: string; site: SigningSite } | null = null;
    for (const [scriptId, url] of scripts) {
      let src: string;
      try {
        const r = await cdp.send('Debugger.getScriptSource', { scriptId });
        src = String(r['scriptSource'] ?? '');
      } catch {
        continue;
      }
      const site = locateSigningSite(src);
      if (site) {
        found = { url, site };
        break;
      }
    }
    cdp.off('Debugger.scriptParsed', onParsed);
    if (!found) {
      throw new GrokOracleSigningSiteError(`scanned ${scripts.size} chunk(s)`);
    }

    // Arm a one-shot paused handler BEFORE triggering a signed request.
    const paused = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cdp.off('Debugger.paused', onPaused);
        reject(new GrokOracleMintError('breakpoint did not trip within timeout'));
      }, this.breakpointTimeoutMs);
      const onPaused = (p: Record<string, unknown>): void => {
        const frames = p['callFrames'];
        const frameId =
          Array.isArray(frames) && frames[0] && typeof (frames[0] as Record<string, unknown>)['callFrameId'] === 'string'
            ? ((frames[0] as Record<string, unknown>)['callFrameId'] as string)
            : '';
        clearTimeout(timer);
        cdp.off('Debugger.paused', onPaused);
        resolve(frameId);
      };
      cdp.on('Debugger.paused', onPaused);
    });

    const bp = await cdp.send('Debugger.setBreakpointByUrl', {
      url: found.url,
      lineNumber: found.site.lineNumber,
      columnNumber: found.site.columnNumber,
    });
    const breakpointId = typeof bp['breakpointId'] === 'string' ? bp['breakpointId'] : '';

    // Any app navigation fires many signed requests → trips the breakpoint.
    page.reload({ waitUntil: 'domcontentloaded', timeout: this.breakpointTimeoutMs }).catch(() => {});

    let callFrameId: string;
    try {
      callFrameId = await paused;
    } finally {
      if (breakpointId) await cdp.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {});
    }

    if (callFrameId) {
      await cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId,
        expression: `globalThis.__grokMint = ${found.site.minterName}`,
      });
    }
    await cdp.send('Debugger.resume').catch(() => {});
    // Leaving the debugger disabled keeps the page fast between mints.
    await cdp.send('Debugger.disable').catch(() => {});

    this.minterReady = true;
    log.info({ minterName: found.site.minterName.length }, 'grok statsig minter exposed');
  }

  /**
   * Mint a fresh token for `(path, method)`. Warms lazily; re-grabs the minter if
   * the page reloaded and dropped `__grokMint`. Returns the token (never logged).
   */
  async mint(reqPath: string, method: string): Promise<string> {
    await this.warm();
    let token = await this.tryEval(reqPath, method);
    if (!token) {
      // Page may have reloaded (minter gone) — re-grab once.
      this.minterReady = false;
      await this.warm();
      token = await this.tryEval(reqPath, method);
    }
    if (!token) throw new GrokOracleMintError('minter returned no token');
    this.touch();
    log.info({ tokenLen: token.length }, 'grok statsig token minted');
    return token;
  }

  private async tryEval(reqPath: string, method: string): Promise<string | null> {
    if (!this.launch) return null;
    try {
      const r = await this.launch.cdp.send('Runtime.evaluate', {
        expression: `globalThis.__grokMint && globalThis.__grokMint(${JSON.stringify(reqPath)}, ${JSON.stringify(method)})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r['exceptionDetails']) return null;
      const result = r['result'] as Record<string, unknown> | undefined;
      const val = result?.['value'];
      return typeof val === 'string' && val.length > 0 ? val : null;
    } catch {
      return null;
    }
  }

  /** Close the browser now. Safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const launch = this.launch;
    this.launch = null;
    this.minterReady = false;
    if (launch) {
      await launch.context.close().catch(() => {});
      log.info('grok statsig oracle closed (idle/explicit)');
    }
  }

  /** Reset the idle-close timer. Unref'd so it never keeps the process alive. */
  private touch(): void {
    if (this.idleMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, this.idleMs);
    if (typeof (this.idleTimer as { unref?: () => void }).unref === 'function') {
      (this.idleTimer as { unref: () => void }).unref();
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton (one browser per process at most)
// ---------------------------------------------------------------------------

let singleton: GrokStatsigOracle | null = null;

/** Process-wide oracle, created lazily with the given profile dir. */
export function getGrokStatsigOracle(opts: GrokStatsigOracleOptions = {}): GrokStatsigOracle {
  if (!singleton) singleton = new GrokStatsigOracle(opts);
  return singleton;
}

/** Reset the singleton — tests only. */
export function __resetGrokStatsigOracle(): void {
  if (singleton) void singleton.close();
  singleton = null;
}
