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
import WebSocket from 'ws';
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
 * Real Playwright launcher: a HEADED persistent-context Chrome (on a virtual
 * display via resolveBrowserDisplay) on the durable grok profile (SSO logged-in),
 * with a CDP session bound to its first page. Headed is MANDATORY: grok.com's
 * Cloudflare gate challenges headless Chrome ("Just a moment...") so its app
 * chunks never load and the minter can't be found. Set SUDO_GROK_ORACLE_HEADLESS=1
 * only for environments proven to pass headless. Same host as the curl_cffi bridge
 * (cf_clearance is IP-bound). Nothing is held open beyond the oracle's idle window.
 */
export function makeRealOracleLauncher(): OracleLauncher {
  return async (profileDir: string): Promise<OracleLaunch> => {
    const executablePath = resolveChromeExecutable() ?? undefined;
    if (!process.env['DISPLAY']) process.env['DISPLAY'] = resolveBrowserDisplay();
    const headless = process.env['SUDO_GROK_ORACLE_HEADLESS'] === '1';
    const context = await chromium.launchPersistentContext(profileDir, {
      headless,
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

/**
 * CDP-connect launcher: attach to a PERSISTENT, already-warm grok browser over
 * the DevTools protocol (env `SUDO_GROK_ORACLE_CDP_URL`, e.g. http://127.0.0.1:9222).
 * This is the ROBUST path: Cloudflare challenges freshly-launched Chrome (headed
 * OR headless) so `makeRealOracleLauncher` can't load grok's app JS; a long-running
 * browser that genuinely solved the CF challenge passes. We never close the shared
 * browser on idle — we only detach our socket. Uses raw CDP over `ws` (reliable;
 * Playwright connectOverCDP is flaky in some hosts).
 */
export function makeCdpConnectLauncher(cdpUrl: string): OracleLauncher {
  return async (): Promise<OracleLaunch> => {
    const base = cdpUrl.replace(/\/$/, '');
    const targets = (await (await fetch(`${base}/json`)).json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }>;
    let target = targets.find((t) => t.type === 'page' && t.url.includes('grok.com'));
    if (!target) {
      const created = (await (
        await fetch(`${base}/json/new?${encodeURIComponent('https://grok.com/imagine')}`, {
          method: 'PUT',
        })
      ).json()) as { url: string; webSocketDebuggerUrl: string };
      target = { type: 'page', url: created.url, webSocketDebuggerUrl: created.webSocketDebuggerUrl };
    }
    const sock = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      sock.once('open', () => resolve());
      sock.once('error', reject);
    });
    let msgId = 0;
    const pending = new Map<number, (v: Record<string, unknown>) => void>();
    const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
    sock.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as {
        id?: number;
        result?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (typeof m.id === 'number' && pending.has(m.id)) {
        pending.get(m.id)!((m.result as Record<string, unknown>) ?? {});
        pending.delete(m.id);
        return;
      }
      if (m.method && handlers.has(m.method)) {
        for (const h of handlers.get(m.method)!) h(m.params ?? {});
      }
    });
    const cdp: OracleCdp = {
      send: (method, params = {}) =>
        new Promise((resolve) => {
          const id = ++msgId;
          pending.set(id, resolve);
          sock.send(JSON.stringify({ id, method, params }));
        }),
      on: (event, handler) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
      },
      off: (event, handler) => {
        handlers.get(event)?.delete(handler);
      },
    };
    let currentUrl = target.url;
    const page: OraclePage = {
      goto: async (url) => {
        await cdp.send('Page.enable');
        await cdp.send('Page.navigate', { url });
        currentUrl = url;
        // Give the SPA a moment to start streaming chunks; exposeMinter polls.
        await new Promise((r) => setTimeout(r, 1500));
      },
      reload: async () => {
        await cdp.send('Page.reload', {});
      },
      url: () => currentUrl,
    };
    const context: OracleContext = {
      // Detach only — the shared browser is NOT ours to close.
      close: async () => {
        try {
          sock.close();
        } catch {
          /* already closed */
        }
      },
      cookies: async () => {
        const r = await cdp.send('Network.getAllCookies');
        return (r['cookies'] as Array<{ name: string; value: string; domain: string }>) ?? [];
      },
    };
    return { context, page, cdp };
  };
}

/**
 * Default launcher: connect to a persistent warm browser when
 * `SUDO_GROK_ORACLE_CDP_URL` is set (recommended — see makeCdpConnectLauncher),
 * else fall back to launching one (only works where CF doesn't challenge it).
 */
export function defaultOracleLauncher(): OracleLauncher {
  const cdpUrl = process.env['SUDO_GROK_ORACLE_CDP_URL'];
  return cdpUrl ? makeCdpConnectLauncher(cdpUrl) : makeRealOracleLauncher();
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
  /** Execution context where __grokMint was hoisted (mints must use it). */
  private mintCtxId: number | undefined;
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
    this.launcher = opts.launcher ?? defaultOracleLauncher();
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
      log.info({ launchMs: this.now() - t0, headless: process.env['SUDO_GROK_ORACLE_HEADLESS'] === '1' }, 'grok statsig oracle launched');
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
    const ctxOf = new Map<string, number>(); // scriptId -> executionContextId

    const onParsed = (p: Record<string, unknown>): void => {
      const id = p['scriptId'];
      const url = p['url'];
      if (typeof id === 'string' && typeof url === 'string' && CHUNK_URL_RE.test(url)) {
        scripts.set(id, url);
        if (typeof p['executionContextId'] === 'number') ctxOf.set(id, p['executionContextId']);
      }
    };
    cdp.on('Debugger.scriptParsed', onParsed);
    await cdp.send('Debugger.enable');
    await cdp.send('Runtime.enable');

    // Load the app so its chunks (incl. the signing chunk) parse. With a headed
    // browser Cloudflare auto-solves and the app JS loads a few seconds later, so
    // we POLL until the signing chunk parses (scanning once right after
    // domcontentloaded races the async Next.js chunks and finds nothing).
    await page.goto(this.navigateUrl, { waitUntil: 'domcontentloaded', timeout: this.breakpointTimeoutMs }).catch(() => {});

    // Find the signing site among the parsed chunks — poll new chunks until the
    // deadline (chunks stream in after domcontentloaded).
    let found: { url: string; site: SigningSite } | null = null;
    const checked = new Set<string>();
    const deadline = this.now() + this.breakpointTimeoutMs;
    while (this.now() < deadline && !found) {
      for (const [scriptId, url] of scripts) {
        if (checked.has(scriptId)) continue;
        checked.add(scriptId);
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
      if (!found) await new Promise((r) => setTimeout(r, 400));
    }
    if (!found) {
      cdp.off('Debugger.scriptParsed', onParsed);
      throw new GrokOracleSigningSiteError(`scanned ${checked.size} chunk(s)`);
    }
    // Keep the scriptParsed listener ACTIVE through the trigger navigation so the
    // re-parsed signing chunk's NEW executionContextId is captured in ctxOf.

    // The minter reads the rendered DOM (seed meta, SVG, animation) — settle the
    // page before we reload to trigger the breakpoint so the grab context sticks.
    await this.waitSettled(cdp);

    // Arm a one-shot paused handler BEFORE triggering a signed request.
    const paused = new Promise<{ frameId: string; scriptId: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        cdp.off('Debugger.paused', onPaused);
        reject(new GrokOracleMintError('breakpoint did not trip within timeout'));
      }, this.breakpointTimeoutMs);
      const onPaused = (p: Record<string, unknown>): void => {
        const frames = p['callFrames'];
        const top =
          Array.isArray(frames) && frames[0] ? (frames[0] as Record<string, unknown>) : undefined;
        const frameId = typeof top?.['callFrameId'] === 'string' ? (top['callFrameId'] as string) : '';
        const loc = top?.['location'] as Record<string, unknown> | undefined;
        const scriptId = typeof loc?.['scriptId'] === 'string' ? (loc['scriptId'] as string) : '';
        clearTimeout(timer);
        cdp.off('Debugger.paused', onPaused);
        resolve({ frameId, scriptId });
      };
      cdp.on('Debugger.paused', onPaused);
    });

    const bp = await cdp.send('Debugger.setBreakpointByUrl', {
      url: found.url,
      lineNumber: found.site.lineNumber,
      columnNumber: found.site.columnNumber,
    });
    const breakpointId = typeof bp['breakpointId'] === 'string' ? bp['breakpointId'] : '';

    // A fresh NAVIGATION (not reload) fires signed requests on the NEW document and
    // traps the breakpoint there, so the minter we hoist lands on the surviving
    // page's global (a reload can trip on the outgoing doc, losing __grokMint).
    page.goto(this.navigateUrl, { waitUntil: 'domcontentloaded', timeout: this.breakpointTimeoutMs }).catch(() => {});

    let callFrameId: string;
    try {
      const pz = await paused;
      callFrameId = pz.frameId;
      // Pin the context where the breakpoint tripped == where we hoist __grokMint;
      // mints MUST evaluate there (the default context can differ post-navigation).
      this.mintCtxId = ctxOf.get(pz.scriptId);
    } finally {
      cdp.off('Debugger.scriptParsed', onParsed);
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

    // Wait for the post-reload page to finish rendering so the very first mint's
    // DOM/animation reads succeed (else the minter returns null).
    await this.waitSettled(cdp);

    this.minterReady = true;
    log.info({ minterName: found.site.minterName.length }, 'grok statsig minter exposed');
  }

  /**
   * Mint a fresh token for `(path, method)`. Warms lazily; re-grabs the minter if
   * the page reloaded and dropped `__grokMint`. Returns the token (never logged).
   */
  async mint(reqPath: string, method: string): Promise<string> {
    await this.warm();
    // The minter reads the fully-rendered DOM (seed meta, SVG paths, a CSS
    // animation) — right after a reload the page may not be ready yet, so the
    // minter returns null. Poll: if `__grokMint` is GONE (page navigated) re-grab
    // it; if it's present but returns null, wait for the render and retry.
    let token: string | null = null;
    const deadline = this.now() + this.breakpointTimeoutMs;
    for (let first = true; !token && this.now() < deadline; first = false) {
      if (!first) await new Promise((r) => setTimeout(r, 800));
      if (!(await this.minterPresent())) {
        this.minterReady = false;
        await this.warm();
      }
      token = await this.tryEval(reqPath, method);
    }
    if (!token) throw new GrokOracleMintError('minter returned no token');
    this.touch();
    log.info({ tokenLen: token.length }, 'grok statsig token minted');
    return token;
  }

  /**
   * Poll until the page is rendered enough for the minter: document.readyState
   * `complete` AND the server-injected seed `<meta name^=gr>` present.
   */
  private async waitSettled(cdp: OracleCdp, timeoutMs = 8_000): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression:
            "document.readyState + '|' + (document.querySelector('meta[name^=gr]') ? '1' : '0')",
          returnByValue: true,
          ...(this.mintCtxId ? { contextId: this.mintCtxId } : {}),
        });
        const v = String((r['result'] as Record<string, unknown> | undefined)?.['value'] ?? '');
        if (v.startsWith('complete') && v.endsWith('|1')) return;
      } catch {
        /* transient context churn during load */
      }
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  /** True if `globalThis.__grokMint` is a live function on the current page. */
  private async minterPresent(): Promise<boolean> {
    if (!this.launch) return false;
    try {
      const r = await this.launch.cdp.send('Runtime.evaluate', {
        expression: "typeof globalThis.__grokMint === 'function'",
        returnByValue: true,
        ...(this.mintCtxId ? { contextId: this.mintCtxId } : {}),
      });
      return (r['result'] as Record<string, unknown> | undefined)?.['value'] === true;
    } catch {
      return false;
    }
  }

  private async tryEval(reqPath: string, method: string): Promise<string | null> {
    if (!this.launch) return null;
    try {
      const r = await this.launch.cdp.send('Runtime.evaluate', {
        expression: `globalThis.__grokMint && globalThis.__grokMint(${JSON.stringify(reqPath)}, ${JSON.stringify(method)})`,
        awaitPromise: true,
        returnByValue: true,
        ...(this.mintCtxId ? { contextId: this.mintCtxId } : {}),
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
