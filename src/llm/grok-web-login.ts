/**
 * @file grok-web-login.ts
 * @description One-time cookie-import login for the free grok.com web lane —
 * kills the login-browser dependency. The operator logs into grok.com ONCE in
 * their own browser, exports the cookies (dev-tools, or a Cookie-Editor export),
 * and pipes them in; we normalize, verify against the seat (statsig-free probe),
 * and persist to the durable session store. No browser in sudo-ai's stack for
 * login — same one-time-auth model as the Gemini seat.
 *
 * cf_clearance is USER-AGENT-bound: the imported cookies must be paired with the
 * SAME User-Agent the browser used, or Cloudflare rejects them. So the import
 * takes (cookie, userAgent) together and warns when cf_clearance is present but
 * the UA is unknown.
 *
 * SECRETS: the cookie is a secret — never logged. Only coarse shape (counts,
 * which essential cookies are present) is surfaced.
 */

import { createLogger } from './grok-runtime.js';
import {
  getGrokWebSessionManager,
  type GrokWebSession,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import { callGrokWebBridge } from './grok-web-bridge.js';

const log = createLogger('llm:grok-web-login');

/** Cookies that must be present for an authenticated grok.com session. */
export interface EssentialCookies {
  /** SSO auth cookie — the durable credential. Required. */
  sso: boolean;
  /** Cloudflare clearance — refreshed often; UA-bound. Recommended. */
  cf_clearance: boolean;
  /** Total cookie count. */
  count: number;
}

/**
 * Normalize pasted cookies into a single `Cookie:` header value. Accepts:
 *  1. a raw header string  `a=1; b=2`  (dev-tools "Copy value" / document.cookie)
 *  2. a JSON array of cookie objects `[{name,value,domain?},…]` (Cookie-Editor /
 *     EditThisCookie export) — filtered to grok/x domains when a domain is present
 *  3. Netscape cookies.txt (tab-separated: domain flag path secure expiry name value)
 */
export function parseCookieInput(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return '';

  // (2) JSON array export
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as Array<{ name?: string; value?: string; domain?: string }>;
      return arr
        .filter((c) => typeof c.name === 'string' && typeof c.value === 'string')
        .filter((c) => !c.domain || /grok\.com|\.x\.ai|(^|\.)x\.com/.test(c.domain))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
    } catch {
      /* fall through — not valid JSON */
    }
  }

  // (3) Netscape cookies.txt (has tabs + multiple lines)
  if (trimmed.includes('\t') && /\n/.test(trimmed)) {
    const pairs: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith('#') || line.trim() === '') continue;
      const cols = line.split('\t');
      if (cols.length >= 7 && cols[5] && cols[6] !== undefined) pairs.push(`${cols[5]}=${cols[6]}`);
    }
    if (pairs.length) return pairs.join('; ');
  }

  // (1) raw header string — collapse whitespace/newlines, keep `k=v; …`
  return trimmed.replace(/\s*[\r\n]+\s*/g, ' ').replace(/;\s*/g, '; ').trim();
}

/** Which essential cookies are present in a Cookie header. */
export function essentialCookies(header: string): EssentialCookies {
  const names = header
    .split(';')
    .map((p) => p.split('=')[0]?.trim().toLowerCase() ?? '')
    .filter(Boolean);
  return {
    sso: names.includes('sso'),
    cf_clearance: names.includes('cf_clearance'),
    count: names.length,
  };
}

export interface ImportResult {
  ok: boolean;
  /** True when a live probe confirmed the cookies authenticate. */
  verified: boolean;
  essential: EssentialCookies;
  detail?: string;
}

export interface ImportOptions {
  /** Live-check the cookies against the seat before saving (default true). */
  verify?: boolean;
  manager?: GrokWebSessionManager;
  bridge?: typeof callGrokWebBridge;
}

/**
 * Import a one-time grok.com session from pasted cookies. Normalizes, checks the
 * essential cookies, optionally verifies live (statsig-free probe), then persists
 * to the durable store. Returns without saving if `sso` is absent or (when
 * verify=true) the probe fails — so we never install a dead session.
 */
export async function importGrokWebSession(
  input: { cookie: string; userAgent?: string },
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const manager = opts.manager ?? getGrokWebSessionManager();
  const bridge = opts.bridge ?? callGrokWebBridge;
  const verify = opts.verify ?? true;

  const cookie = parseCookieInput(input.cookie);
  const essential = essentialCookies(cookie);

  if (!cookie) return { ok: false, verified: false, essential, detail: 'no cookies parsed from input' };
  if (!essential.sso) {
    return { ok: false, verified: false, essential, detail: 'missing sso cookie — not an authenticated grok.com session' };
  }

  // cf_clearance is UA-bound; keep the UA that produced it.
  const existing = manager.loadSession();
  const userAgent = input.userAgent ?? existing?.userAgent;
  if (!userAgent) {
    return {
      ok: false,
      verified: false,
      essential,
      detail: 'userAgent required (cf_clearance is UA-bound) — paste your browser User-Agent alongside the cookies',
    };
  }

  let verified = false;
  if (verify) {
    const r = await bridge({ op: 'probe' }, { cookie, userAgent });
    if (!r.ok) {
      return {
        ok: false,
        verified: false,
        essential,
        detail: `probe failed (${r.errorClass ?? 'error'}) — cookies did not authenticate`,
      };
    }
    verified = true;
  }

  const session: GrokWebSession = { cookie, userAgent, capturedAt: new Date().toISOString() };
  manager.saveSession(session);
  log.info(
    { cookieCount: essential.count, hasCfClearance: essential.cf_clearance, verified },
    'grok-web session imported from cookies',
  );
  return { ok: true, verified, essential };
}
