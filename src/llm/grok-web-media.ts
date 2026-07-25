/**
 * @file grok-web-media.ts
 * @description GW5 — subscription-free image/video generation on the user's Grok
 * web session, exposed as a capability distinct from the metered xAI API path.
 *
 * Ties GW3 (session manager) + GW2 (replay bridge) + GW4 (headless refresh)
 * together behind the `SUDO_GROK_WEBSESSION` flag (default OFF). IMAGE is the
 * robust primary (WS lane, no statsig); VIDEO is best-effort (needs a live
 * statsig — see A-GW1). Respects the 18h quota window: reads quota_info and, on
 * exhaustion, INFORMS the caller — it NEVER silently falls back to the metered
 * API (that would spend money; only an explicit opt-in may do so, elsewhere).
 *
 * Secrets never logged. Everything returned to a caller is a URL / local path /
 * counts — never cookie or statsig material.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import { wireGrokWebRefresher } from './grok-web-capture.js';
import { callGrokWebBridge, type GrokWebCreds } from './grok-web-bridge.js';
import { buildChatMessage, parseGrokReply } from './grok-web-tools.js';
import { getGrokStatsigPool, demoteGrokBrowserlessStatsig } from './grok-statsig-pool.js';
import type { IRMessage, IRTool, IRContentBlock } from '../../shared-types/ir/v1.js';

const log = createLogger('llm:grok-web-media');

/** The app-chat conversations path is the only statsig-gated endpoint. */
const APP_CHAT_NEW = '/rest/app-chat/conversations/new';
/** Minimum plausible x-statsig-id length; the oracle intermittently yields ''. */
const MIN_STATSIG_LEN = 80;

/** Where generated media lands by default. */
const MEDIA_DIR = path.join(DATA_DIR, 'grok-web-media');

/** True when the subscription-free web-session lane is enabled. Default OFF. */
export function isGrokWebSessionEnabled(): boolean {
  return process.env['SUDO_GROK_WEBSESSION'] === '1';
}

/** Raised when the feature flag is off — callers surface a clear hint. */
export class GrokWebDisabledError extends Error {
  readonly code = 'GROK_WEBSESSION_DISABLED';
  constructor() {
    super('Grok web-session media is disabled — set SUDO_GROK_WEBSESSION=1 to enable (default OFF).');
    this.name = 'GrokWebDisabledError';
  }
}

/** Raised when the 18h free quota window is exhausted for the requested tier. */
export class GrokWebQuotaExhaustedError extends Error {
  readonly code = 'GROK_WEBSESSION_QUOTA_EXHAUSTED';
  constructor(tier: string) {
    super(
      `Grok subscription ${tier} quota is exhausted for the current 18h window. ` +
        `Try again later. (Not falling back to the metered xAI API — that would spend money.)`,
    );
    this.name = 'GrokWebQuotaExhaustedError';
  }
}

export interface GrokImageResult {
  /** Public URL of the first image (imagine-public.x.ai). */
  url: string | null;
  /** Local paths of saved JPEGs. */
  files: string[];
  jobIds: Array<string | null>;
}

export interface GrokVideoResult {
  /** assets.grok.com mp4 URL. */
  videoUrl: string;
  thumbnailUrl?: string;
  /** The source image (public URL) for image-to-video; null for text-to-video. */
  imageUrl: string | null;
  /** Local path of the downloaded mp4 (undefined if the download step failed). */
  file?: string;
  videoId?: string;
}

/**
 * Raised when the free lane returns 429 — the SuperGrok weekly pool ceiling or
 * the ~40/2h burst throttle. Distinct from other failures so the brain router
 * can FAIL OVER (to another model) rather than retry a lane that won't recover
 * until reset. Never triggers a metered-API fallback.
 */
export class GrokWebRateLimitedError extends Error {
  readonly code = 'GROK_WEBSESSION_RATE_LIMITED';
  readonly shouldFailover = true;
  constructor(lane: string) {
    super(
      `Grok ${lane} lane is rate-limited (429) — SuperGrok weekly pool or 2h burst ` +
        `throttle. Fail over to another model; do not retry until reset.`,
    );
    this.name = 'GrokWebRateLimitedError';
  }
}

export interface GrokVoiceTtsResult {
  /** base64-encoded audio. */
  audioBase64: string;
  /** Container, e.g. "wav". */
  audioFormat: string;
  sampleRate?: number;
  durationMs?: number;
}

export interface GrokVoiceSttResult {
  /** Transcribed text. */
  text: string;
  words?: Array<{ word: string; startMs?: number; endMs?: number; alignScore?: number }>;
}

export interface GrokChatResult {
  /** Final assistant text (may be a prompt-emulated <tool_call> block — the
   * caller's grok-web-tools parser decides tool_use vs final answer). */
  text: string;
  /** Reasoning stream, when isReasoning was requested. */
  reasoning?: string;
  modelHash?: string;
}

export interface GrokMediaDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokWebBridge;
  /** Milliseconds clock for filenames. */
  now: () => number;
  /**
   * GWV2 — mint a FRESH x-statsig-id for the video app-chat request. Defaults to
   * the on-demand headless oracle (grok-statsig-oracle.ts), lazy-loaded so
   * image-only callers never pull in Playwright. Injected in tests.
   */
  mintStatsig?: (reqPath: string, method: string) => Promise<string>;
}

function defaultDeps(): GrokMediaDeps {
  const manager = getGrokWebSessionManager();
  // Wire the real headless refresher once (idempotent enough — setter).
  wireGrokWebRefresher(manager);
  return { manager, bridge: callGrokWebBridge, now: () => Date.now() };
}

function credsOf(session: { cookie: string; userAgent: string; statsigId?: string }): GrokWebCreds {
  const c: GrokWebCreds = { cookie: session.cookie, userAgent: session.userAgent };
  if (session.statsigId) c.statsigId = session.statsigId;
  return c;
}

/** Ensure the feature is on + the session is healthy (refreshing if needed). */
async function ready(deps: GrokMediaDeps) {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  const session = await deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
  return session;
}

/** Read the current quota tiers (probe). Throws if not healthy. */
async function quotaFor(deps: GrokMediaDeps, creds: GrokWebCreds): Promise<Record<string, { available: boolean }>> {
  const r = await deps.bridge({ op: 'probe' }, creds);
  return r.quota ?? {};
}

/**
 * Generate image(s) from a text prompt on the Grok subscription (WS lane).
 * Saves JPEGs under DATA_DIR/grok-web-media and returns their paths + the
 * imagine-public URL of the first.
 */
export async function generateGrokImage(
  prompt: string,
  opts: { aspectRatio?: string; numGenerations?: number; pro?: boolean; deps?: GrokMediaDeps } = {},
): Promise<GrokImageResult> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const creds = credsOf(session);

  const quota = await quotaFor(deps, creds);
  const tier = opts.pro ? 'imagePro' : 'image';
  if (quota[tier] && quota[tier]!.available === false) throw new GrokWebQuotaExhaustedError(tier);

  const imgReq = {
    op: 'image' as const,
    prompt,
    aspectRatio: opts.aspectRatio ?? '1:1',
    numGenerations: opts.numGenerations ?? 1,
    pro: opts.pro ?? false,
  };
  const r = await deps.bridge(imgReq, creds);
  if (!r.ok || !r.images?.length) {
    throw new Error(`Grok image generation failed: ${r.errorClass ?? 'no images'}${r.detail ? ` (${r.detail})` : ''}`);
  }

  await mkdir(MEDIA_DIR, { recursive: true });
  const files: string[] = [];
  const jobIds: Array<string | null> = [];
  for (const [i, img] of r.images.entries()) {
    const name = `grok-${img.jobId ?? `${deps.now()}-${i}`}.jpg`;
    const p = path.join(MEDIA_DIR, name);
    await writeFile(p, Buffer.from(img.b64, 'base64'), { mode: 0o644 });
    files.push(p);
    jobIds.push(img.jobId);
  }
  const url = r.images[0]?.publicUrl ?? null;
  log.info({ count: files.length, hasUrl: Boolean(url) }, 'grok-web image generated');
  return { url, files, jobIds };
}

/**
 * Mint a fresh x-statsig-id via the on-demand headless oracle (GWV1). Lazy import
 * keeps Playwright out of the image-only path. Bound to the session's durable
 * grok profile.
 */
function makeOracleMint(profileDir?: string): (reqPath: string, method: string) => Promise<string> {
  return async (reqPath: string, method: string): Promise<string> => {
    // Attach to an external warm browser if configured, else auto-provision a
    // managed one (GWV6) — unless explicitly disabled with SUDO_GROK_WARM_BROWSER=0.
    let cdpUrl = process.env['SUDO_GROK_ORACLE_CDP_URL'];
    if (!cdpUrl && process.env['SUDO_GROK_WARM_BROWSER'] !== '0') {
      const { getWarmGrokBrowser } = await import('./grok-warm-browser.js');
      cdpUrl = await getWarmGrokBrowser(profileDir ? { profileDir } : {}).ensureRunning();
    }
    const { getGrokStatsigOracle } = await import('./grok-statsig-oracle.js');
    const oracle = getGrokStatsigOracle({
      ...(cdpUrl ? { cdpUrl } : {}),
      ...(profileDir ? { profileDir } : {}),
    });
    return oracle.mint(reqPath, method);
  };
}

/** True when the pure-Node browserless statsig fast-path is enabled. Default OFF. */
export function isGrokStatsigBrowserlessEnabled(): boolean {
  return process.env['SUDO_GROK_STATSIG_BROWSERLESS'] === '1';
}

type MintSession = { cookie: string; userAgent: string; profileDir?: string; statsigId?: string };

/**
 * Mint an x-statsig-id in PURE NODE (no browser): fetch a fresh page seed via the
 * curl_cffi bridge, then derive the fingerprint + assemble the token locally
 * (grok-statsig-mint.ts). Throws on any failure so the caller can fall back to the
 * browser oracle. Reverse-engineered from module 4629918; verified byte-exact vs
 * the live minter + the live anti-bot gate. See docs/OPUS_HANDOFF_PATHB_NODE_MINTER.md.
 */
async function mintStatsigBrowserless(
  reqPath: string,
  method: string,
  session: MintSession,
  deps: GrokMediaDeps,
): Promise<string> {
  const r = await deps.bridge({ op: 'seed' }, credsOf(session));
  if (!r.ok || !r.seed) {
    throw new Error(`seed fetch failed: ${r.errorClass ?? 'no seed'}${r.detail ? ` (${r.detail})` : ''}`);
  }
  const { mintStatsigFromSeed } = await import('./grok-statsig-mint.js');
  return mintStatsigFromSeed(r.seed, reqPath, method, deps.now());
}

/**
 * Statsig minter with a browserless FAST-PATH. When SUDO_GROK_STATSIG_BROWSERLESS
 * is on, the FIRST mint of a request is done in pure Node (no browser launch);
 * any failure — or a re-mint after a downstream 403 — falls back to the headed
 * warm-browser oracle, which stays the default + authoritative path. Stateful per
 * video request: `browserlessTried` ensures the 403-retry escalates to the oracle
 * rather than re-minting the same (rejected) browserless token.
 */
function makeBrowserlessFirstMint(
  session: MintSession,
  deps: GrokMediaDeps,
): (reqPath: string, method: string) => Promise<string> {
  const oracleMint = makeOracleMint(session.profileDir);
  let browserlessTried = false;
  return async (reqPath: string, method: string): Promise<string> => {
    if (isGrokStatsigBrowserlessEnabled() && !browserlessTried) {
      browserlessTried = true;
      try {
        const token = await mintStatsigBrowserless(reqPath, method, session, deps);
        log.info({ tokenLen: token.length }, 'grok statsig minted browserless (pure-Node fast-path)');
        return token;
      } catch (err) {
        log.warn(
          { detail: (err as Error).message },
          'grok statsig browserless mint failed — falling back to the browser oracle',
        );
      }
    }
    return oracleMint(reqPath, method);
  };
}

/**
 * Mint a statsig token for the app-chat endpoint, retrying when the underlying
 * minter throws OR returns an empty/too-short token (the warm-browser oracle
 * intermittently yields '' on a cold/navigating page). Each retry re-invokes
 * the injected mint, which itself escalates browserless→oracle. Throws only
 * after `attempts` genuinely-failed mints — callers treat that as a transient
 * lane failure, never a metered-API fallback.
 */
async function mintValidatedStatsig(
  mint: (reqPath: string, method: string) => Promise<string>,
  attempts = 4,
): Promise<string> {
  let lastLen = 0;
  for (let i = 0; i < attempts; i++) {
    try {
      const tok = await mint(APP_CHAT_NEW, 'POST');
      if (tok && tok.length >= MIN_STATSIG_LEN) return tok;
      lastLen = tok ? tok.length : 0;
      log.warn({ attempt: i + 1, len: lastLen }, 'statsig mint returned short/empty token — retrying');
    } catch (err) {
      log.warn({ attempt: i + 1, detail: (err as Error).message }, 'statsig mint threw — retrying');
    }
  }
  throw new Error(`statsig mint failed after ${attempts} attempts (last token len ${lastLen})`);
}

/** True when quota_info reports the video tier is out for the current window. */
function videoQuotaExhausted(quota: Record<string, unknown>): boolean {
  const q = (quota['video720p'] ?? quota['video']) as Record<string, unknown> | undefined;
  if (!q) return false;
  if (q['available'] === false) return true;
  const remaining = q['remainingQueries'];
  return typeof remaining === 'number' && remaining <= 0;
}

/**
 * Generate a video FREE on the Grok subscription via the statsig-oracle lane
 * (GWV2). Text-to-video by default (PROVEN); image-to-video when `imageUrl` is
 * given. Mints a FRESH x-statsig-id per request (never replays), curl_cffi-POSTs
 * the app-chat stream, downloads the resulting assets.grok.com mp4, and returns
 * URLs + the local path. On a 403 anti-bot rejection it re-mints ONCE and
 * retries; it NEVER falls back to the metered api.x.ai (that would spend money).
 * Returns only structured data (URLs / ids / path) — never free-form model text.
 */
export async function generateGrokVideo(
  prompt: string,
  opts: {
    imageUrl?: string;
    aspectRatio?: string;
    videoLength?: number;
    resolutionName?: string;
    deps?: GrokMediaDeps;
  } = {},
): Promise<GrokVideoResult> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const creds = credsOf(session);

  const quota = await quotaFor(deps, creds);
  if (videoQuotaExhausted(quota as Record<string, unknown>)) throw new GrokWebQuotaExhaustedError('video');

  const mint = deps.mintStatsig ?? makeBrowserlessFirstMint(session, deps);
  const aspect = opts.aspectRatio ?? '9:16';

  const attempt = async (): Promise<import('./grok-web-bridge.js').GrokWebResponse> => {
    // Mint fresh + use in <1s; never store/replay the token.
    const statsigId = await mint('/rest/app-chat/conversations/new', 'POST');
    const vidReq = {
      op: 'video' as const,
      aspectRatio: aspect,
      videoLength: opts.videoLength ?? 6,
      resolutionName: opts.resolutionName ?? '720p',
      ...(opts.imageUrl ? { imageUrl: opts.imageUrl } : { prompt }),
    };
    // The freshly-minted token wins over any session-stored statsig.
    return deps.bridge(vidReq, { ...creds, statsigId });
  };

  let r = await attempt();
  if (!r.ok && (r.errorClass === 'statsig' || r.status === 403)) {
    // Anti-bot 403 / stale statsig → re-mint once and retry.
    log.info('grok-web video: 403/statsig — re-minting once');
    r = await attempt();
  }
  if (!r.ok || !r.videoUrl) {
    if (r.errorClass === 'statsig' || r.status === 403) {
      throw new Error(
        'Grok video: request rejected by anti-bot rules even after a fresh mint. ' +
          'Not falling back to the metered xAI API (that would spend money) — try again shortly.',
      );
    }
    throw new Error(`Grok video generation failed: ${r.errorClass ?? 'no video'}${r.detail ? ` (${r.detail})` : ''}`);
  }

  const out: GrokVideoResult = { videoUrl: r.videoUrl, imageUrl: opts.imageUrl ?? null };
  if (r.thumbnailUrl) out.thumbnailUrl = r.thumbnailUrl;
  if (r.videoId) out.videoId = r.videoId;

  // Download the mp4 with the session cookies (same host), best-effort.
  await mkdir(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, `grok-video-${r.videoId ?? deps.now()}.mp4`);
  const dl = await deps.bridge({ op: 'download', url: r.videoUrl, outputPath: file }, creds);
  if (dl.ok && dl.path) {
    out.file = dl.path;
    log.info({ bytes: dl.bytes ?? 0, ftyp: dl.ftyp === true }, 'grok-web video downloaded');
  } else {
    log.warn({ errorClass: dl.errorClass }, 'grok-web video downloaded URL but local save failed');
  }
  log.info('grok-web video generated (oracle lane)');
  return out;
}

/**
 * Synthesize speech on the seat-covered voice lane (statsig-FREE — no anti-bot
 * mint needed, unlike chat/video). Returns base64 audio + format. Draws the
 * subscription voice quota; never the metered API.
 */
export async function synthesizeGrokVoice(
  text: string,
  opts: { voice?: string; sanitize?: boolean; enableAlignment?: boolean; timeoutSec?: number; deps?: GrokMediaDeps } = {},
): Promise<GrokVoiceTtsResult> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge(
    {
      op: 'voice_tts',
      text,
      ...(opts.voice ? { voice: opts.voice } : {}),
      ...(opts.sanitize !== undefined ? { sanitize: opts.sanitize } : {}),
      ...(opts.enableAlignment !== undefined ? { enableAlignment: opts.enableAlignment } : {}),
      ...(opts.timeoutSec ? { timeoutSec: opts.timeoutSec } : {}),
    },
    credsOf(session),
  );
  if (!r.ok || typeof r.audioBase64 !== 'string') {
    throw new Error(`Grok voice TTS failed: ${r.errorClass ?? 'no audio'}${r.detail ? ` (${r.detail})` : ''}`);
  }
  const out: GrokVoiceTtsResult = { audioBase64: r.audioBase64, audioFormat: r.audioFormat ?? 'wav' };
  if (r.sampleRate !== undefined) out.sampleRate = r.sampleRate;
  if (r.durationMs !== undefined) out.durationMs = r.durationMs;
  return out;
}

/**
 * Transcribe audio on the seat-covered voice lane (statsig-FREE). `audioBase64`
 * is the base64 of the raw audio bytes; `audioFormat` its container.
 */
export async function transcribeGrokVoice(
  audioBase64: string,
  opts: { audioFormat?: string; enhance?: boolean; timeoutSec?: number; deps?: GrokMediaDeps } = {},
): Promise<GrokVoiceSttResult> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const r = await deps.bridge(
    {
      op: 'voice_stt',
      audioBase64,
      ...(opts.audioFormat ? { audioFormat: opts.audioFormat } : {}),
      ...(opts.enhance !== undefined ? { enhance: opts.enhance } : {}),
      ...(opts.timeoutSec ? { timeoutSec: opts.timeoutSec } : {}),
    },
    credsOf(session),
  );
  if (!r.ok || typeof r.text !== 'string') {
    throw new Error(`Grok voice STT failed: ${r.errorClass ?? 'no text'}${r.detail ? ` (${r.detail})` : ''}`);
  }
  const out: GrokVoiceSttResult = { text: r.text };
  if (r.words) out.words = r.words;
  return out;
}

/**
 * Text chat on the FREE grok.com app-chat lane — the door the mobile/desktop/web
 * apps use, drawn from the SuperGrok *weekly pool* (NOT cli-chat-proxy's daily
 * free bucket, NOT the metered API). Mirrors generateGrokVideo's statsig
 * discipline: mints a FRESH x-statsig-id per attempt (chat is anti-bot-protected
 * exactly like video — the gap that made chat 403 without a mint), re-mints ONCE
 * on a 403, and NEVER falls back to the metered api.x.ai. `message` is built by
 * the caller (grok-web-tools.buildChatMessage) and the reply parsed by
 * grok-web-tools.parseGrokReply; this function only handles session + statsig +
 * transport. Returns raw model text — quarantine before it drives control flow.
 */
export async function chatGrokWeb(
  message: string,
  opts: {
    modelName?: string;
    disableSearch?: boolean;
    isReasoning?: boolean;
    timeoutSec?: number;
    /** Managed-embedding collections to ground on (collectionsSearch). */
    collectionIds?: string[];
    deps?: GrokMediaDeps;
  } = {},
): Promise<GrokChatResult> {
  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);
  const creds = credsOf(session);
  // Real path: pull a fresh single-use token from the API-level pool (pre-minted
  // ahead of demand, oracle-backed). Tests inject deps.mintStatsig → validate it
  // directly (no pool, so mint-count assertions stay exact).
  const injectedMint = deps.mintStatsig;
  const acquireStatsig: () => Promise<string> = injectedMint
    ? () => mintValidatedStatsig(injectedMint)
    : () => getGrokStatsigPool().acquire();

  const send = async (): Promise<import('./grok-web-bridge.js').GrokWebResponse> => {
    // Fresh, validated, single-use token per send; never store/replay it.
    const statsigId = await acquireStatsig();
    const req = {
      op: 'chat' as const,
      message,
      modelName: opts.modelName ?? 'grok-4',
      temporary: true,
      disableSearch: opts.disableSearch ?? true,
      ...(opts.isReasoning ? { isReasoning: true } : {}),
      ...(opts.collectionIds ? { collectionIds: opts.collectionIds } : {}),
      ...(opts.timeoutSec ? { timeoutSec: opts.timeoutSec } : {}),
    };
    return deps.bridge(req, { ...creds, statsigId });
  };

  // Up to 3 sends, each with a FRESH single-use statsig. A 403/statsig means the
  // token was stale/rejected → re-mint and retry. A 429 is the pool/burst
  // throttle → surface for failover (won't recover on retry). Other errors: stop.
  let r: import('./grok-web-bridge.js').GrokWebResponse | undefined;
  for (let i = 0; i < 3; i++) {
    r = await send();
    if (r.ok && typeof r.text === 'string') break;
    if (r.status === 429) throw new GrokWebRateLimitedError('chat');
    if (r.errorClass === 'statsig' || r.status === 403) {
      log.info({ attempt: i + 1 }, 'grok-web chat: 403/statsig — re-minting');
      continue;
    }
    break; // non-retryable error class
  }
  if (!r || !r.ok || typeof r.text !== 'string') {
    if (r && r.status === 429) throw new GrokWebRateLimitedError('chat');
    if (r && (r.errorClass === 'statsig' || r.status === 403)) {
      // Persistent anti-bot 403 after fresh (pooled) mints: if browserless was in
      // play, the pure-Node algorithm may have drifted → demote to the oracle so
      // the next turns self-heal to browser-backed minting (drift canary alerts).
      if (!injectedMint && process.env['SUDO_GROK_STATSIG_BROWSERLESS'] === '1') {
        demoteGrokBrowserlessStatsig();
      }
      throw new Error(
        'Grok chat: request rejected by anti-bot rules even after fresh mints. ' +
          'Not falling back to the metered xAI API (that would spend money) — try again shortly.',
      );
    }
    throw new Error(
      `Grok web chat failed: ${r?.errorClass ?? 'no text'}${r?.detail ? ` (${r.detail})` : ''}`,
    );
  }

  const out: GrokChatResult = { text: r.text };
  if (r.reasoning) out.reasoning = r.reasoning;
  if (r.modelHash) out.modelHash = r.modelHash;
  return out;
}

/**
 * One brain turn on the FREE app-chat lane, IR-shaped. Given IR messages + the
 * tool roster, returns the assistant's IR content blocks — either a single
 * `tool_use` block (grok chose a tool) or a `text` block (final answer). This is
 * the primitive sudo-ai's own ReACT loop calls per model step: sudo-ai executes
 * the tool and calls again, so this does NOT loop internally (that is
 * runGrokWebToolLoop, for standalone use). Model text is raw/external — the
 * caller quarantines before it drives control flow.
 */
export async function grokWebComplete(
  messages: readonly IRMessage[],
  tools: readonly IRTool[],
  opts: { modelName?: string; system?: string; timeoutSec?: number; deps?: GrokMediaDeps } = {},
): Promise<IRContentBlock[]> {
  const message = buildChatMessage(messages, tools, opts.system);
  const r = await chatGrokWeb(message, {
    modelName: opts.modelName ?? 'grok-4',
    ...(opts.timeoutSec ? { timeoutSec: opts.timeoutSec } : {}),
    ...(opts.deps ? { deps: opts.deps } : {}),
  });
  const parsed = parseGrokReply(r.text);
  if (parsed.kind === 'tool_use') {
    return [{ type: 'tool_use', id: parsed.id, name: parsed.name, input: parsed.input }];
  }
  return [{ type: 'text', text: parsed.text }];
}

export { GrokWebReloginRequiredError };
