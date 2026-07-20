/**
 * @file grok-web-capture.ts
 * @description GW4 — headless capture + on-demand refresh of a grok.com web
 * session, using the Spec-3 durable-browser primitive
 * (`chromium.launchPersistentContext`). This is the heavy dep GW3 deliberately
 * kept out of the manager: it imports playwright + the browser anti-detect
 * helpers and provides the `GrokWebRefresher` the manager calls.
 *
 * Two entry points, one mechanism:
 *   - capture-at-setup: open the durable profile (where the user has already
 *     logged into grok.com via SSO), wait for Cloudflare to auto-issue
 *     cf_clearance, harvest all grok.com cookies + the UA + a fresh x-statsig-id
 *     (the video lane needs it), persist 0600 via the manager.
 *   - on-demand refresh: same thing, triggered when a replay returns
 *     403-Cloudflare (or app-chat 403 = stale statsig). A real browser with a
 *     valid `sso` re-clears Cloudflare in seconds. NO browser is held open —
 *     the context is closed (~5-10s) before returning.
 *
 * Error discipline (docs/grok-web-imagine-protocol.md §7): if the profile lands
 * on a login page / has no `sso` cookie, throw GrokWebReloginRequiredError so
 * the manager sets needsRelogin (never a refresh loop). curl_cffi's
 * REST-403-Cloudflare vs gRPC-404 distinction lives in the python bridge; this
 * module only handles the browser side.
 *
 * Secrets (cookies, statsig) are NEVER logged — counts/booleans only.
 */

import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { buildLaunchArgs, resolveChromeExecutable, resolveBrowserDisplay } from '../core/tools/builtin/browser/anti-detect.js';
import { createLogger } from '../core/shared/logger.js';
import {
  GrokWebReloginRequiredError,
  type GrokWebRefresher,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';

const log = createLogger('llm:grok-web-capture');

const IMAGINE_URL = 'https://grok.com/imagine';
/** Cookies whose domain ends with this are carried into the replay Cookie header. */
const GROK_COOKIE_DOMAIN = 'grok.com';
/** Max wall time to wait for Cloudflare clearance + a statsig-bearing request. */
const DEFAULT_CLEAR_TIMEOUT_MS = 30_000;
/** Optional running-browser CDP endpoint used to sniff a live x-statsig-id (video lane). */
const CDP_STATSIG_ENDPOINT = process.env['GROK_WEB_CDP_ENDPOINT'] ?? '';

export interface GrokWebCaptureResult {
  cookie: string;
  userAgent: string;
  statsigId?: string;
  profileDir?: string;
}

/**
 * A launched persistent context + its first page. Minimal surface so tests can
 * substitute a fake without a real browser.
 */
export interface LaunchedContext {
  context: Pick<BrowserContext, 'cookies' | 'close' | 'newPage' | 'pages'>;
  page: Pick<Page, 'goto' | 'reload' | 'on' | 'evaluate' | 'url' | 'waitForTimeout'>;
}

/** Injectable launcher — real playwright by default, faked in tests. */
export type PersistentLauncher = (profileDir: string) => Promise<LaunchedContext>;

/**
 * Build the real playwright launcher. `headless:false` is used at capture-at-setup
 * because the headless imagine SPA does NOT fire its boot /rest/ calls (so no
 * x-statsig-id can be sniffed — video lane); a headed load on the box's DISPLAY
 * fires them reliably. Refresh defaults to headless (image-only is enough there;
 * statsig re-capture on a 403 can request headed). NOTHING is held open either way.
 */
export function makeRealLauncher(headless = true): PersistentLauncher {
  return async (profileDir: string): Promise<LaunchedContext> => {
    const executablePath = resolveChromeExecutable() ?? undefined;
    if (!headless && !process.env['DISPLAY']) process.env['DISPLAY'] = resolveBrowserDisplay();
    const context = await chromium.launchPersistentContext(profileDir, {
      headless,
      executablePath,
      args: buildLaunchArgs(),
      viewport: { width: 1280, height: 800 },
      // Strict TLS by default: this browser harvests grok.com session cookies, so a
      // MITM with a forged cert must NOT be able to feed us a bogus session. Opt-out
      // only for a dev environment that needs it, via explicit env flag.
      ignoreHTTPSErrors: process.env['SUDO_GROK_WEB_INSECURE_TLS'] === '1',
    });
    context.on('dialog', (d) => {
      d.dismiss().catch(() => {});
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page };
  };
}

const realLauncher: PersistentLauncher = makeRealLauncher(true);

/**
 * Build the grok.com Cookie header from a persistent context's cookie jar.
 * Includes every cookie on the grok.com apex/subdomains verbatim.
 */
function buildCookieHeader(cookies: Array<{ name: string; value: string; domain: string }>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const c of cookies) {
    const dom = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    if (dom !== GROK_COOKIE_DOMAIN && !dom.endsWith('.' + GROK_COOKIE_DOMAIN)) continue;
    if (seen.has(c.name)) continue; // first (most-specific) wins
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join('; ');
}

/**
 * Sniff a fresh x-statsig-id from a LIVE, already-running logged-in browser via
 * CDP. This is the RELIABLE statsig source (the video lane): a fresh
 * Playwright-launched context does NOT boot grok's API layer, so it never emits
 * a statsig-bearing /rest/ request — but the user's real Chrome does, constantly.
 * Best-effort: returns undefined if no endpoint / nothing seen in the window.
 * Never launches a browser; only attaches to an existing one.
 */
export async function captureStatsigViaCDP(
  endpoint: string,
  timeoutMs = 20_000,
): Promise<string | undefined> {
  if (!endpoint) return undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    browser = await chromium.connectOverCDP(endpoint);
    let statsig: string | undefined;
    for (const ctx of browser.contexts()) {
      for (const pg of ctx.pages()) {
        pg.on('request', (req) => {
          try {
            if (!req.url().includes('grok.com')) return;
            const s = req.headers()['x-statsig-id'];
            if (s && !statsig) statsig = s;
          } catch { /* ignore */ }
        });
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !statsig) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (statsig) log.info({ statsigLen: statsig.length }, 'grok-web statsig sniffed via live CDP');
    return statsig;
  } catch (err) {
    log.warn({ err: String(err) }, 'grok-web CDP statsig sniff failed (best-effort)');
    return undefined;
  } finally {
    // Do NOT close the live browser — we only attached. Disconnect the CDP link.
    try { await browser?.close(); } catch { /* ignore */ }
  }
}

/**
 * Open the durable profile, wait for Cloudflare clearance, and harvest
 * cookies + UA + x-statsig-id. Closes the context before returning (nothing
 * held open). Throws GrokWebReloginRequiredError when `sso` is absent / the
 * profile is on a login page.
 */
export async function captureGrokWebSession(
  profileDir: string,
  opts: { launcher?: PersistentLauncher; clearTimeoutMs?: number; headless?: boolean; cdpEndpoint?: string } = {},
): Promise<GrokWebCaptureResult> {
  const launcher = opts.launcher ?? makeRealLauncher(opts.headless ?? true);
  const clearTimeoutMs = opts.clearTimeoutMs ?? DEFAULT_CLEAR_TIMEOUT_MS;
  const { context, page } = await launcher(profileDir);
  let statsigId: string | undefined;
  try {
    // Sniff x-statsig-id off any grok.com /rest/ request the app fires on load.
    page.on('request', (req: { url: () => string; headers: () => Record<string, string> }) => {
      try {
        const u = req.url();
        if (!u.includes('grok.com')) return;
        const h = req.headers();
        const s = h['x-statsig-id'];
        if (s && !statsigId) statsigId = s;
      } catch {
        /* ignore */
      }
    });

    await page.goto(IMAGINE_URL, { waitUntil: 'domcontentloaded', timeout: clearTimeoutMs });

    // Poll until Cloudflare cleared (cf_clearance present) AND we've seen a
    // statsig, or the deadline passes. cf_clearance auto-issues for a real
    // browser with a valid sso; statsig is emitted by the app's first /rest/ call.
    const deadline = Date.now() + clearTimeoutMs;
    let cookies = await context.cookies('https://grok.com');
    while (Date.now() < deadline) {
      cookies = await context.cookies('https://grok.com');
      const hasClearance = cookies.some((c) => c.name === 'cf_clearance');
      if (hasClearance && statsigId) break;
      await page.waitForTimeout(500);
    }

    // Cloudflare may clear before the app has fired a statsig-bearing /rest/ call
    // (headless is slower to mount the imagine UI). A reload reliably triggers the
    // boot /rest/ calls (quota_info/GetGrokCreditsConfig) which carry x-statsig-id.
    // statsig is video-only + best-effort (A-GW1): one reload, short extra wait.
    if (!statsigId && cookies.some((c) => c.name === 'cf_clearance')) {
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: clearTimeoutMs });
      } catch {
        /* reload best-effort */
      }
      const statsigDeadline = Date.now() + Math.min(clearTimeoutMs, 15_000);
      while (Date.now() < statsigDeadline && !statsigId) {
        await page.waitForTimeout(500);
      }
      cookies = await context.cookies('https://grok.com');
    }

    // Video-lane statsig: if the fresh context never emitted one (it usually
    // won't — grok's API layer doesn't boot under automation), try the live
    // browser via CDP. Best-effort per A-GW1; image is unaffected.
    if (!statsigId) {
      const ep = opts.cdpEndpoint ?? CDP_STATSIG_ENDPOINT;
      if (ep) statsigId = await captureStatsigViaCDP(ep, Math.min(clearTimeoutMs, 20_000));
    }

    const url = page.url();
    const hasSso = cookies.some((c) => c.name === 'sso' && c.value);
    if (!hasSso || /\/sign-in|auth\.x\.ai|\/login/.test(url)) {
      log.error({ url: url.replace(/\?.*$/, ''), hasSso }, 'grok-web capture: no sso / login page — relogin required');
      throw new GrokWebReloginRequiredError();
    }

    const cookie = buildCookieHeader(cookies);
    if (!cookie || !cookies.some((c) => c.name === 'cf_clearance')) {
      // No Cloudflare clearance issued — treat as a transient failure, not relogin.
      throw new Error('grok-web capture: cf_clearance not issued within timeout');
    }
    const userAgent = String(await page.evaluate(() => navigator.userAgent));
    log.info(
      { cookieCount: cookies.length, cookieLen: cookie.length, hasStatsig: Boolean(statsigId), uaLen: userAgent.length },
      'grok-web session captured',
    );
    return { cookie, userAgent, statsigId, profileDir };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * A GrokWebRefresher bound to a durable profile dir. When the manager has a
 * stored profileDir it is used; otherwise this default is used. Refresh with an
 * undefined profileDir and no default → error (can't refresh without a profile;
 * the operator must run setup first).
 */
export function makeGrokWebRefresher(opts: { defaultProfileDir?: string; launcher?: PersistentLauncher; clearTimeoutMs?: number; headless?: boolean } = {}): GrokWebRefresher {
  return async (profileDir: string | undefined): Promise<GrokWebCaptureResult> => {
    const dir = profileDir ?? opts.defaultProfileDir;
    if (!dir) {
      throw new GrokWebReloginRequiredError();
    }
    const captureOpts: { launcher?: PersistentLauncher; clearTimeoutMs?: number; headless?: boolean } = {};
    if (opts.launcher) captureOpts.launcher = opts.launcher;
    if (opts.clearTimeoutMs !== undefined) captureOpts.clearTimeoutMs = opts.clearTimeoutMs;
    if (opts.headless !== undefined) captureOpts.headless = opts.headless;
    return captureGrokWebSession(dir, captureOpts);
  };
}

/**
 * Boot wiring: give the manager its real headless refresher (call once at
 * startup, e.g. from the CLI/provider init when SUDO_GROK_WEBSESSION is on).
 */
export function wireGrokWebRefresher(manager: GrokWebSessionManager, defaultProfileDir?: string): void {
  const opts: { defaultProfileDir?: string } = {};
  if (defaultProfileDir !== undefined) opts.defaultProfileDir = defaultProfileDir;
  manager.setRefresher(makeGrokWebRefresher(opts));
}
