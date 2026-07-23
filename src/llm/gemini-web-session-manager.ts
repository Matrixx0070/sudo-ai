/**
 * @file gemini-web-session-manager.ts
 * @description File-backed session holder for the gemini.google.com WEB seat, so the
 * lane runs headless (no browser) after a one-time cookie capture. Mirrors
 * `grok-web-session-manager.ts`: DATA_DIR persistence, 0600 atomic writes, secrets
 * never logged (lengths/booleans only), needs-relogin discipline.
 *
 * The credential is a captured set of Google account cookies. Health model:
 *   - `__Secure-1PSID`      = the long-lived login (weeks) — human re-login when dead.
 *   - `__Secure-1PSIDTS`    = short-lived; auto-refreshed via accounts.google.com/RotateCookies.
 * The SNlM0e access token is re-scraped from /app on each use (cheap) and cached briefly.
 *
 * Capture the cookie file once from a logged-in browser with
 * `scripts/gemini-web/capture-cookies.mts`; thereafter this manager needs no browser.
 * Pure request/parse logic lives in `gemini-web-mint.ts`; this module owns persistence,
 * rotation, and the generate() flow.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/shared/paths.js';
import { writeFileAtomic } from '../core/shared/atomic-write.js';
import { createLogger } from '../core/shared/logger.js';
import {
  GEMINI_ENDPOINTS,
  extractInitData,
  buildStreamGenerateRequest,
  parseGeminiFrames,
  extractCandidates,
  extractMedia,
  GeminiAuthError,
  type GeminiWebModelName,
  type GeminiCandidate,
  type GeneratedImageRef,
  type GeneratedVideoRef,
  type GeneratedMediaRef,
  type WebImageRef,
} from './gemini-web-mint.js';

const log = createLogger('llm:gemini-web-session');

const DEFAULT_STORE_PATH = path.join(DATA_DIR, 'gemini-web-session.json');
const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** Re-scrape the SNlM0e token at most this often (ms); it is cheap but not free. */
const TOKEN_TTL_MS = 5 * 60 * 1000;
/** Skip a rotate if the last one was within this window (avoids 429), per the reference. */
const ROTATE_MIN_INTERVAL_MS = 60 * 1000;

/** On-disk session (0600). Secret: `cookies`. */
export interface GeminiWebSessionFile {
  /** Google cookie name -> value (all google.com cookies from the logged-in browser). */
  cookies: Record<string, string>;
  /** User-Agent captured with the cookies — replayed on every request. */
  userAgent: string;
  /** ISO 8601 — when captured / last refreshed. */
  capturedAt: string;
  /** Set when `__Secure-1PSID` is dead — a human must re-capture. */
  needsRelogin?: boolean;
}

export interface GeminiWebStatus {
  connected: boolean;
  capturedAt?: string;
  needsRelogin?: boolean;
  cookieCount?: number;
}

/** Minimal fetch shape (Node global fetch satisfies it, incl. getSetCookie()). */
export type SessionFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  text: () => Promise<string>;
  headers: { getSetCookie?: () => string[] };
}>;

/** Build a `Cookie:` header value from a name->value map. */
export function cookieHeaderFrom(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Pull the fresh `__Secure-1PSIDTS` value out of a Set-Cookie header list. Pure.
 * Returns null if none present.
 */
export function parse1PSIDTS(setCookies: string[]): string | null {
  for (const sc of setCookies ?? []) {
    const m = /^__Secure-1PSIDTS=([^;]+)/.exec(sc);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Reply from a headless generate call. */
export interface GeminiWebReply extends GeminiCandidate {}

/** File-backed manager over <DATA_DIR>/gemini-web-session.json. */
export class GeminiWebSessionManager {
  private readonly storePath: string;
  private readonly fetchImpl: SessionFetch;
  private token: string | null = null;
  private buildLabel: string | null = null;
  private sessionId: string | null = null;
  private language: string | null = null;
  private tokenAt = 0;
  private lastRotateAt = 0;

  constructor(opts?: { storePath?: string; fetchImpl?: SessionFetch }) {
    this.storePath = opts?.storePath ?? DEFAULT_STORE_PATH;
    this.fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as unknown as SessionFetch);
  }

  /** Load the session file, or null if absent/invalid. */
  load(): GeminiWebSessionFile | null {
    if (!existsSync(this.storePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as GeminiWebSessionFile;
      if (!parsed.cookies || typeof parsed.cookies !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Persist the session file atomically at 0600. Cookies are never logged. */
  save(session: GeminiWebSessionFile): void {
    const dir = path.dirname(this.storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileAtomic(this.storePath, JSON.stringify(session, null, 2), { mode: 0o600 });
    log.info(
      { cookieCount: Object.keys(session.cookies).length, needsRelogin: !!session.needsRelogin },
      'gemini web session saved',
    );
  }

  /** Save from freshly captured cookies (used by the one-time capture script). */
  saveFromCookies(cookies: Record<string, string>, userAgent?: string): void {
    this.save({
      cookies,
      userAgent: userAgent || DEFAULT_UA,
      capturedAt: new Date().toISOString(),
    });
  }

  status(): GeminiWebStatus {
    const s = this.load();
    if (!s) return { connected: false };
    return {
      connected: !s.needsRelogin,
      capturedAt: s.capturedAt,
      needsRelogin: s.needsRelogin,
      cookieCount: Object.keys(s.cookies).length,
    };
  }

  private headers(session: GeminiWebSessionFile, extra?: Record<string, string>): Record<string, string> {
    return {
      'User-Agent': session.userAgent || DEFAULT_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: cookieHeaderFrom(session.cookies),
      ...extra,
    };
  }

  private markRelogin(session: GeminiWebSessionFile, reason: string): never {
    this.save({ ...session, needsRelogin: true });
    log.warn({ reason }, 'gemini web session needs re-login (human re-capture)');
    throw new GeminiAuthError(`gemini web session dead: ${reason} — re-capture cookies`);
  }

  /** Refresh __Secure-1PSIDTS via RotateCookies and persist. Returns true on refresh. */
  async rotate(session: GeminiWebSessionFile): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastRotateAt < ROTATE_MIN_INTERVAL_MS) return false;
    this.lastRotateAt = now;
    const res = await this.fetchImpl(GEMINI_ENDPOINTS.ROTATE_COOKIES, {
      method: 'POST',
      headers: this.headers(session, { 'Content-Type': 'application/json', Origin: 'https://accounts.google.com' }),
      body: '[000,"-0000000000000000000"]',
    });
    if (res.status === 401) this.markRelogin(session, 'rotate 401');
    const fresh = parse1PSIDTS(res.headers.getSetCookie?.() ?? []);
    if (!fresh) {
      log.debug({ status: res.status }, 'rotate returned no new 1PSIDTS');
      return false;
    }
    session.cookies['__Secure-1PSIDTS'] = fresh;
    this.save(session);
    log.info('gemini __Secure-1PSIDTS rotated');
    return true;
  }

  /** GET /app and scrape the access token; caches for TOKEN_TTL_MS. */
  private async ensureToken(session: GeminiWebSessionFile, force = false): Promise<boolean> {
    if (!force && this.token && Date.now() - this.tokenAt < TOKEN_TTL_MS) return true;
    const res = await this.fetchImpl(GEMINI_ENDPOINTS.INIT, { method: 'GET', headers: this.headers(session) });
    if (res.status !== 200) {
      log.debug({ status: res.status }, 'init GET non-200');
      return false;
    }
    const init = extractInitData(await res.text());
    if (!init.accessToken) return false;
    this.token = init.accessToken;
    this.buildLabel = init.buildLabel;
    this.sessionId = init.sessionId;
    this.language = init.language;
    this.tokenAt = Date.now();
    return true;
  }

  /** Load the file, verify liveness, and ensure a token (rotate+retry once). */
  private async ready(): Promise<GeminiWebSessionFile> {
    const session = this.load();
    if (!session) throw new GeminiAuthError(`no gemini session file at ${this.storePath} — run capture-cookies first`);
    if (session.needsRelogin) throw new GeminiAuthError('gemini session marked needs-relogin — re-capture cookies');
    if (!(await this.ensureToken(session))) {
      await this.rotate(session);
      if (!(await this.ensureToken(session, true))) this.markRelogin(session, 'no SNlM0e after rotate');
    }
    return session;
  }

  /** POST StreamGenerate and return the parsed frames; rotates+retries once on 401. */
  private async fetchFrames(
    session: GeminiWebSessionFile,
    prompt: string,
    opts?: { model?: GeminiWebModelName },
  ): Promise<unknown[]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const req = buildStreamGenerateRequest({
        prompt,
        accessToken: this.token!,
        buildLabel: this.buildLabel,
        sessionId: this.sessionId,
        language: this.language ?? 'en',
        model: opts?.model,
      });
      const url = `${req.url}?${new URLSearchParams(req.params).toString()}`;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(session, req.headers),
        body: new URLSearchParams(req.form).toString(),
      });
      if (res.status === 401 && attempt === 0) {
        await this.rotate(session);
        await this.ensureToken(session, true);
        continue;
      }
      if (res.status !== 200) throw new GeminiAuthError(`StreamGenerate HTTP ${res.status}`);
      return parseGeminiFrames(await res.text());
    }
    throw new GeminiAuthError('gemini generate failed after retry');
  }

  /**
   * Generate a text reply headlessly from the persisted cookies. Rotates 1PSIDTS and
   * retries once on an auth failure; marks needs-relogin if the login itself is dead.
   */
  async generate(prompt: string, opts?: { model?: GeminiWebModelName }): Promise<GeminiWebReply> {
    const session = await this.ready();
    const cands = extractCandidates(await this.fetchFrames(session, prompt, opts));
    if (!cands.length) {
      throw new Error('gemini StreamGenerate 200 but no reply candidates — reply indices may have drifted');
    }
    return cands[0]!;
  }

  /**
   * Generate and return any text + generated media (images/videos/audio) — the free
   * multimodal payoff of the web seat. Media may be empty (text-only replies).
   */
  async generateMedia(
    prompt: string,
    opts?: { model?: GeminiWebModelName },
  ): Promise<{
    text: string;
    images: GeneratedImageRef[];
    videos: GeneratedVideoRef[];
    media: GeneratedMediaRef[];
    webImages: WebImageRef[];
  }> {
    const session = await this.ready();
    const frames = await this.fetchFrames(session, prompt, opts);
    const text = extractCandidates(frames)[0]?.text ?? '';
    const m = extractMedia(frames);
    return {
      text,
      images: m.flatMap((c) => c.generatedImages),
      videos: m.flatMap((c) => c.generatedVideos),
      media: m.flatMap((c) => c.generatedMedia),
      webImages: m.flatMap((c) => c.webImages),
    };
  }
}

let singleton: GeminiWebSessionManager | null = null;
/** Process-wide manager over <DATA_DIR>/gemini-web-session.json, created lazily. */
export function getGeminiWebSessionManager(): GeminiWebSessionManager {
  if (!singleton) singleton = new GeminiWebSessionManager();
  return singleton;
}

/** Convenience drop-in: headless text generation from the persisted session. */
export async function generateGeminiWebText(
  prompt: string,
  opts?: { model?: GeminiWebModelName },
): Promise<string> {
  return (await getGeminiWebSessionManager().generate(prompt, opts)).text;
}
