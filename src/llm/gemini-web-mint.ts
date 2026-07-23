/**
 * @file gemini-web-mint.ts
 * @description Pure-Node (browserless) client spine for the **gemini.google.com WEB
 * seat** — the Gemini analog of the grok web-session lane (`grok-web-session-manager.ts`
 * / `grok-statsig-mint.ts`).
 *
 * Unlike the grok statsig lane there is **no computed fingerprint to mint**: the Gemini
 * web "token" is the `SNlM0e` XSRF value scraped from the logged-in app HTML, paired with
 * Google account cookies (`__Secure-1PSID` / `__Secure-1PSIDTS`). So "minting" here = GET
 * the app page with cookies and scrape the init data. This module holds the deterministic,
 * unit-testable spine — scrape init data, build the StreamGenerate request, parse the
 * length-prefixed response frames — plus one impure orchestrator (`mintGeminiWebSession`)
 * that takes an injected `fetch` so it is testable without a browser or live cookies.
 *
 * Protocol verified 2026-07-23 against the mature reference `HanaokaYuzu/Gemini-API`
 * (endpoints, regexes, `f.req` shape, frame framing, reply indices).
 *
 * SECURITY: cookies and the access token are values — this module NEVER logs them.
 * This module is inert (unwired); nothing on the hot path imports it.
 */

import { randomUUID } from 'node:crypto';

/** gemini.google.com web endpoints. */
export const GEMINI_ENDPOINTS = {
  /** GET here (with cookies) to scrape the init data (SNlM0e etc.). */
  INIT: 'https://gemini.google.com/app',
  /** POST the StreamGenerate RPC here. */
  GENERATE:
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
  /** POST here to rotate the __Secure-1PSIDTS cookie. */
  ROTATE_COOKIES: 'https://accounts.google.com/RotateCookies',
} as const;

/** Static headers the web app sends on the StreamGenerate POST. */
const GEMINI_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
  Origin: 'https://gemini.google.com',
  Referer: 'https://gemini.google.com/',
  'X-Same-Domain': '1',
} as const;

const MODEL_HEADER_KEY = 'x-goog-ext-525001261-jspb';
// Metadata placeholder used for a fresh (no-history) conversation turn.
const DEFAULT_METADATA = ['', '', '', null, null, null, null, null, null, ''] as const;

// SCAFFOLD: model_id + capacity are grok-spinner-class brittle constants — internal
// Google build ids that change when the web app reskins its model catalog. If
// StreamGenerate starts returning ErrorCode 1052 (MODEL_HEADER_INVALID), re-capture
// these from `x-goog-ext-525001261-jspb` in a live request via the reference repo
// (HanaokaYuzu/Gemini-API constants.py) and refresh this map + the test fixtures.
export const GEMINI_WEB_MODELS = {
  'gemini-3-flash': { modelId: 'fbb127bbb056c959', capacity: 1 },
  'gemini-3-pro': { modelId: '9d8ca3786ebdfbea', capacity: 1 },
} as const;
export type GeminiWebModelName = keyof typeof GEMINI_WEB_MODELS;

/** Build the model-selection headers for a given web model. */
export function buildModelHeader(model: GeminiWebModelName): Record<string, string> {
  const { modelId, capacity } = GEMINI_WEB_MODELS[model];
  return {
    [MODEL_HEADER_KEY]: `[1,null,null,null,"${modelId}",null,null,0,[4],null,null,${capacity}]`,
    'x-goog-ext-73010989-jspb': '[0]',
    'x-goog-ext-73010990-jspb': '[0]',
  };
}

/** Data scraped from the initialized gemini.google.com/app HTML. */
export interface GeminiInitData {
  /** SNlM0e — the XSRF/access token; the `at` field on every generate POST. */
  accessToken: string | null;
  /** cfb2h — the build label; the `bl` query param. */
  buildLabel: string | null;
  /** FdrFJe — the session id; the `f.sid` query param. */
  sessionId: string | null;
  /** TuX5cc — the UI language; the `hl` query param. */
  language: string | null;
  /** qKIAYe — the file-push id (used by the upload lane; not needed for text). */
  pushId: string | null;
}

// Field name -> regex over the app HTML. Verbatim from the reference get_access_token.py.
const INIT_FIELD_PATTERNS: Record<keyof GeminiInitData, RegExp> = {
  accessToken: /"SNlM0e":\s*"(.*?)"/,
  buildLabel: /"cfb2h":\s*"(.*?)"/,
  sessionId: /"FdrFJe":\s*"(.*?)"/,
  language: /"TuX5cc":\s*"(.*?)"/,
  pushId: /"qKIAYe":\s*"(.*?)"/,
};

/**
 * Scrape the init data from the app HTML. Pure. Any field that is absent comes back
 * `null` (the reference treats "at least one present" as a successful init).
 */
export function extractInitData(html: string): GeminiInitData {
  const out = {} as GeminiInitData;
  for (const key of Object.keys(INIT_FIELD_PATTERNS) as (keyof GeminiInitData)[]) {
    const m = INIT_FIELD_PATTERNS[key].exec(html ?? '');
    out[key] = m ? m[1] : null;
  }
  return out;
}

/**
 * Safely navigate a nested JSON structure by a path of indices/keys, returning
 * `fallback` when the path cannot be fully traversed. Port of the reference
 * `get_nested_value`.
 */
export function getNested(data: unknown, path: (number | string)[], fallback: unknown = undefined): unknown {
  let cur: unknown = data;
  for (const key of path) {
    if (typeof key === 'number' && Array.isArray(cur) && key >= -cur.length && key < cur.length) {
      cur = cur[key < 0 ? cur.length + key : key];
    } else if (typeof key === 'string' && cur !== null && typeof cur === 'object' && key in (cur as object)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return fallback;
    }
  }
  return cur === null || cur === undefined ? fallback : cur;
}

// Count how many JS characters (code points) span `utf16Units` UTF-16 units from
// startIdx. Google's frame length marker counts UTF-16 units (JS String.length).
function charsForUtf16Units(s: string, startIdx: number, utf16Units: number): number {
  let count = 0;
  let units = 0;
  const limit = s.length;
  while (units < utf16Units && startIdx + count < limit) {
    const cp = s.codePointAt(startIdx + count)!;
    const u = cp > 0xffff ? 2 : 1;
    if (units + u > utf16Units) break;
    units += u;
    // A surrogate-pair code point is 2 JS chars.
    count += cp > 0xffff ? 2 : 1;
  }
  return count;
}

/**
 * Parse Google's length-prefixed streaming frames into a flat list of JSON values.
 * Each frame is `<utf16-length>\n<json>`; list frames are flattened (extended), matching
 * the reference `parse_response_by_frame` + `extract_json_from_response`. Falls back to
 * whole-body then NDJSON parsing. Pure.
 */
export function parseGeminiFrames(raw: string): unknown[] {
  if (typeof raw !== 'string') return [];
  let content = raw;
  if (content.startsWith(")]}'")) content = content.slice(4);
  content = content.replace(/^\s+/, '');

  const frames: unknown[] = [];
  let pos = 0;
  const total = content.length;
  const marker = /(\d+)\n/y; // sticky: must match at `pos`
  while (pos < total) {
    while (pos < total && /\s/.test(content[pos])) pos++;
    if (pos >= total) break;
    marker.lastIndex = pos;
    const m = marker.exec(content);
    if (!m || m.index !== pos) break;
    const length = parseInt(m[1], 10);
    const startContent = pos + m[1].length + 1; // digits + '\n'
    const charCount = charsForUtf16Units(content, startContent, length);
    // Incomplete trailing frame — stop (streaming would wait for more).
    if (charCount === 0 && length > 0) break;
    const chunk = content.slice(startContent, startContent + charCount).trim();
    pos = startContent + charCount;
    if (!chunk) continue;
    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) frames.push(...parsed);
      else frames.push(parsed);
    } catch {
      /* skip malformed frame, mirror reference */
    }
  }
  if (frames.length) return frames;

  // Fallback: whole body as one JSON value.
  try {
    const parsed = JSON.parse(content.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    /* fall through to NDJSON */
  }
  const collected: unknown[] = [];
  for (const line of content.trim().split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) collected.push(...parsed);
      else collected.push(parsed);
    } catch {
      /* skip */
    }
  }
  return collected;
}

/** One reply candidate extracted from the response frames. */
export interface GeminiCandidate {
  /** Conversation id (c). */
  cid: string | null;
  /** Reply id (r). */
  rid: string | null;
  /** Reply-candidate id (rc) — needed to choose/continue a candidate. */
  rcid: string | null;
  /** The reply text. */
  text: string;
}

/**
 * Extract reply candidates from parsed frames. Documented path (reference client.py
 * `_process_parts`/`_parse_candidate`): each part's `[2]` is a JSON string whose `[1]`
 * holds `[cid, rid, ...]` and whose `[4]` is the candidate list; each candidate's `[0]`
 * is the rcid and `[1][0]` is the text. Pure.
 *
 * SCAFFOLD: the `[4]` / `[1][0]` reply indices are version-brittle (they moved across
 * Bard→Gemini revisions). If replies come back empty on a live 200, re-verify these
 * against a captured response and against the reference `_parse_candidate`. Media
 * (image/video) candidate indices are intentionally out of scope for this V1 text spine.
 */
export function extractCandidates(frames: unknown[]): GeminiCandidate[] {
  const out: GeminiCandidate[] = [];
  for (const part of frames) {
    const innerStr = getNested(part, [2]);
    if (typeof innerStr !== 'string') continue;
    let pj: unknown;
    try {
      pj = JSON.parse(innerStr);
    } catch {
      continue;
    }
    const cid = getNested(pj, [1, 0], null) as string | null;
    const rid = getNested(pj, [1, 1], null) as string | null;
    const candidates = getNested(pj, [4], []) as unknown[];
    if (!Array.isArray(candidates)) continue;
    for (const cand of candidates) {
      const rcid = getNested(cand, [0], null) as string | null;
      const text = getNested(cand, [1, 0], '') as string;
      if (typeof text === 'string' && text) out.push({ cid, rid, rcid, text });
    }
  }
  return out;
}

/** Options for {@link buildStreamGenerateRequest}. */
export interface StreamGenerateOptions {
  prompt: string;
  /** SNlM0e access token (from the mint). */
  accessToken: string;
  /** cfb2h build label → `bl` param. */
  buildLabel?: string | null;
  /** FdrFJe session id → `f.sid` param. */
  sessionId?: string | null;
  /** UI language → `hl` param (default 'en'). */
  language?: string | null;
  /** Web model (default 'gemini-3-flash'). */
  model?: GeminiWebModelName;
  /** Injectable for deterministic tests; defaults to a random 5-digit id. */
  reqId?: number;
  /** Injectable for deterministic tests; defaults to a random UUID. */
  uuid?: string;
}

/** A ready-to-send StreamGenerate request (caller performs the POST). */
export interface StreamGenerateRequest {
  url: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  /** `application/x-www-form-urlencoded` fields: `at` + `f.req`. */
  form: { at: string; 'f.req': string };
}

/**
 * Build the StreamGenerate POST exactly as the web app does: the length-69 inner request
 * list wrapped as `f.req = [null, JSON(inner)]`, plus the `at` token and query params.
 * Deterministic when `reqId` and `uuid` are supplied. Verbatim shape from reference
 * client.py (lines ~822-888). Pure.
 */
export function buildStreamGenerateRequest(opts: StreamGenerateOptions): StreamGenerateRequest {
  const language = opts.language || 'en';
  const model = opts.model ?? 'gemini-3-flash';
  const reqId = opts.reqId ?? Math.floor(10000 + Math.random() * 90000);
  const uuid = (opts.uuid ?? randomUUID()).toUpperCase();

  const messageContent = [opts.prompt, 0, null, null, null, null, 0];

  const inner: unknown[] = new Array(69).fill(null);
  inner[0] = messageContent;
  inner[1] = [language];
  inner[2] = [...DEFAULT_METADATA];
  inner[6] = [1];
  inner[7] = 1; // STREAMING_FLAG_INDEX
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = uuid;
  inner[61] = [];
  inner[68] = 2;

  const params: Record<string, string> = { hl: language, _reqid: String(reqId), rt: 'c' };
  if (opts.buildLabel) params.bl = opts.buildLabel;
  if (opts.sessionId) params['f.sid'] = opts.sessionId;

  const headers: Record<string, string> = {
    ...GEMINI_HEADERS,
    ...buildModelHeader(model),
    'x-goog-ext-525005358-jspb': `["${uuid}",1]`,
  };

  const form = {
    at: opts.accessToken,
    'f.req': JSON.stringify([null, JSON.stringify(inner)]),
  };

  return { url: GEMINI_ENDPOINTS.GENERATE, params, headers, form };
}

/** A minted gemini.google.com web session. */
export interface GeminiWebSession extends GeminiInitData {
  accessToken: string; // narrowed: mint throws if this is null
  /** The cookie header value used (for reuse on the generate POST). */
  cookieHeader: string;
}

export class GeminiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiAuthError';
  }
}

/** Minimal fetch shape this module needs (Node 18+ global fetch satisfies it). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ status: number; text: () => Promise<string> }>;

/**
 * "Mint" a Gemini web session: GET the app page with the given Google cookies and scrape
 * the init data. Impure (network) but the `fetch` is injected so it is unit-testable with
 * a fixture. Throws {@link GeminiAuthError} if the page yields no access token (expired /
 * missing cookies).
 *
 * @param cookieHeader a `Cookie:` header value, e.g. `__Secure-1PSID=...; __Secure-1PSIDTS=...`
 * @param fetchImpl injectable fetch (defaults to global fetch)
 */
export async function mintGeminiWebSession(
  cookieHeader: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<GeminiWebSession> {
  const res = await fetchImpl(GEMINI_ENDPOINTS.INIT, {
    method: 'GET',
    headers: { ...GEMINI_HEADERS, Cookie: cookieHeader },
  });
  if (res.status !== 200) {
    throw new GeminiAuthError(`gemini init GET returned ${res.status} (cookies expired or blocked)`);
  }
  const init = extractInitData(await res.text());
  if (!init.accessToken) {
    throw new GeminiAuthError('no SNlM0e in app HTML — cookies invalid/expired or app markup changed');
  }
  return { ...init, accessToken: init.accessToken, cookieHeader };
}
