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

import { randomUUID, randomBytes } from 'node:crypto';

/** gemini.google.com web endpoints. */
export const GEMINI_ENDPOINTS = {
  /** GET here (with cookies) to scrape the init data (SNlM0e etc.). */
  INIT: 'https://gemini.google.com/app',
  /** POST the StreamGenerate RPC here. */
  GENERATE:
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
  /** POST here to rotate the __Secure-1PSIDTS cookie. */
  ROTATE_COOKIES: 'https://accounts.google.com/RotateCookies',
  /** POST batched RPCs here (Deep Research status, read-chat, etc.). */
  BATCH_EXEC: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
} as const;

/** Google RPC ids used by the batchexecute lane. */
export const GEMINI_RPC = {
  DEEP_RESEARCH_STATUS: 'kwDCne',
  READ_CHAT: 'hNvQHb',
  DEEP_RESEARCH_BOOTSTRAP: 'ku4Jyf',
  DEEP_RESEARCH_MODEL_STATE: 'qpEbW',
  DEEP_RESEARCH_CAPS: 'aPya6c',
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
    } else if (
      typeof key === 'string' &&
      cur !== null &&
      typeof cur === 'object' &&
      !Array.isArray(cur) && // string keys address objects only (reference: dict-only)
      key in (cur as object)
    ) {
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

// ---------------------------------------------------------------------------
// Media extraction (image / video / audio) — the free-multimodal payoff.
// ---------------------------------------------------------------------------

/** An image the model surfaced from the web. */
export interface WebImageRef {
  url: string;
  alt: string;
}
/** An image the model generated (Imagen / Nano-Banana). */
export interface GeneratedImageRef {
  url: string;
  alt: string;
  imageId: string;
}
/** A video the model generated (Veo). */
export interface GeneratedVideoRef {
  url: string;
  thumbnail: string;
}
/** Audio/music the model generated. */
export interface GeneratedMediaRef {
  /** mp4 url (video-with-audio), if any. */
  url: string;
  thumbnail: string;
  mp3Url: string;
  mp3Thumbnail: string;
}
/** Media grouped per reply candidate. */
export interface GeminiMediaCandidate {
  cid: string | null;
  rid: string | null;
  rcid: string | null;
  webImages: WebImageRef[];
  generatedImages: GeneratedImageRef[];
  generatedVideos: GeneratedVideoRef[];
  generatedMedia: GeneratedMediaRef[];
}

const asArray = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const asStr = (x: unknown): string => (typeof x === 'string' ? x : '');

/**
 * Extract generated/web media from parsed frames — the free image/video/audio payoff
 * of the web seat over the API tier. Only candidates carrying media are returned.
 * Pure.
 *
 * SCAFFOLD: these nested media indices are the MOST version-brittle part of the whole
 * lane (they moved repeatedly across Bard→Gemini revisions). If media comes back empty
 * on a live generation, re-verify against a captured response and the reference
 * `_parse_candidate` (HanaokaYuzu/Gemini-API client.py). Verbatim map (2026-07-23):
 *   web images       cand[12][1][*]      url [0][0][0], alt [0][4]
 *   generated images cand[12][7][0][*] + cand[12][0]["8"][0][*]  url [0][3][3], alt [0][3][2], id [1][0]
 *   generated videos cand[12][59][0][0][0]  -> [0][7] = [thumb, url]
 *   generated media  cand[12][86]           -> [0][1][7]=mp3 [thumb,url], [1][1][7]=mp4 [thumb,url]
 */
export function extractMedia(frames: unknown[]): GeminiMediaCandidate[] {
  const out: GeminiMediaCandidate[] = [];
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

      const webImages: WebImageRef[] = [];
      for (const w of asArray(getNested(cand, [12, 1], []))) {
        const url = getNested(w, [0, 0, 0]);
        if (typeof url === 'string' && url) webImages.push({ url, alt: asStr(getNested(w, [0, 4], '')) });
      }

      const generatedImages: GeneratedImageRef[] = [];
      const genImgData = [
        ...asArray(getNested(cand, [12, 7, 0], [])),
        ...asArray(getNested(cand, [12, 0, '8', 0], [])),
      ];
      for (const g of genImgData) {
        const url = getNested(g, [0, 3, 3]);
        if (typeof url === 'string' && url) {
          generatedImages.push({
            url,
            alt: asStr(getNested(g, [0, 3, 2], '')),
            imageId: asStr(getNested(g, [1, 0], '')),
          });
        }
      }

      const generatedVideos: GeneratedVideoRef[] = [];
      const videoInfo = getNested(cand, [12, 59, 0, 0, 0], []);
      if (Array.isArray(videoInfo) && videoInfo.length) {
        const urls = getNested(videoInfo, [0, 7], []);
        if (Array.isArray(urls) && urls.length >= 2) {
          generatedVideos.push({ url: String(urls[1]), thumbnail: String(urls[0]) });
        }
      }

      const generatedMedia: GeneratedMediaRef[] = [];
      const mediaData = getNested(cand, [12, 86], []);
      if (Array.isArray(mediaData) && mediaData.length) {
        const mp3 = getNested(mediaData, [0, 1, 7], []);
        const mp4 = getNested(mediaData, [1, 1, 7], []);
        const mp3ok = Array.isArray(mp3) && mp3.length >= 2;
        const mp4ok = Array.isArray(mp4) && mp4.length >= 2;
        const mp3Thumbnail = mp3ok ? String((mp3 as unknown[])[0]) : '';
        const mp3Url = mp3ok ? String((mp3 as unknown[])[1]) : '';
        const thumbnail = mp4ok ? String((mp4 as unknown[])[0]) : '';
        const url = mp4ok ? String((mp4 as unknown[])[1]) : '';
        if (mp3Url || url) generatedMedia.push({ url, thumbnail, mp3Url, mp3Thumbnail });
      }

      if (webImages.length || generatedImages.length || generatedVideos.length || generatedMedia.length) {
        out.push({ cid, rid, rcid, webImages, generatedImages, generatedVideos, generatedMedia });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deep Research plan parsing.
// ---------------------------------------------------------------------------

/** A Deep Research plan the model proposes before running (the first DR step). */
export interface DeepResearchPlan {
  researchId: string | null;
  title: string | null;
  query: string | null;
  /** Human-readable "label: body" research steps. */
  steps: string[];
  etaText: string | null;
  confirmPrompt: string | null;
  confirmationUrl: string | null;
  modifyPrompt: string | null;
  rawState: number | null;
  responseText: string | null;
  /** Conversation id (c_…) the plan turn created — needed to start/poll research. */
  cid: string | null;
  /** Conversation metadata to continue the chat when confirming the plan. */
  metadata: unknown[];
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function* iterNested(data: unknown): Generator<unknown> {
  yield data;
  if (Array.isArray(data)) {
    for (const it of data) yield* iterNested(it);
  } else if (data !== null && typeof data === 'object') {
    for (const it of Object.values(data as Record<string, unknown>)) yield* iterNested(it);
  }
}
function findFirstMatch(data: unknown, re: RegExp): string | null {
  for (const it of iterNested(data)) {
    if (typeof it === 'string') {
      const m = re.exec(it);
      if (m) return m[0];
    }
  }
  return null;
}
function findFirstDictKey(data: unknown, key: string): Record<string, unknown> | null {
  for (const it of iterNested(data)) {
    if (it !== null && typeof it === 'object' && !Array.isArray(it) && key in (it as object)) {
      return it as Record<string, unknown>;
    }
  }
  return null;
}
function findFirstString(data: unknown, exclude: Set<string> = new Set()): string | null {
  for (const it of iterNested(data)) {
    if (typeof it === 'string' && it && !exclude.has(it)) return it;
  }
  return null;
}

/**
 * Parse a Deep Research PLAN from a single candidate. Mirrors the reference
 * `extract_deep_research_plan`: the plan lives in a nested object under key "56" (or
 * "57"); title=[0], steps=[1] (each [label,body] at [1],[2]), query=[1][0][2],
 * eta=[2], confirmPrompt=[3][0], confirmationUrl=[4][0], modifyPrompt=first string of
 * [5]; rawState=meta["70"]. Returns null when no plan is present. Pure.
 *
 * SCAFFOLD: DR plan indices are version-brittle like the media block — re-verify
 * against a live capture + the reference if a plan comes back null on a real DR turn.
 */
export function extractDeepResearchPlan(candidateData: unknown, fallbackText = ''): DeepResearchPlan | null {
  let metaDict: Record<string, unknown> | null = null;
  let payload: unknown[] | null = null;
  for (const key of ['56', '57']) {
    const md = findFirstDictKey(candidateData, key);
    if (md && Array.isArray(md[key])) {
      metaDict = md;
      payload = md[key] as unknown[];
      break;
    }
  }
  if (!metaDict || !payload) return null;

  const researchId = findFirstMatch(candidateData, UUID_RE);
  const title = getNested(payload, [0]);
  const titleStr = typeof title === 'string' ? title : null;

  const steps: string[] = [];
  const stepsPayload = getNested(payload, [1], []) as unknown[];
  if (Array.isArray(stepsPayload)) {
    for (const step of stepsPayload) {
      if (!Array.isArray(step)) continue;
      const label = typeof step[1] === 'string' ? step[1] : null;
      const body = typeof step[2] === 'string' ? step[2] : null;
      if (label && body) steps.push(`${label}: ${body}`);
      else if (body) steps.push(body);
      else if (label) steps.push(label);
    }
  }

  const modifyPayload = getNested(payload, [5]);
  const modifyPrompt = Array.isArray(modifyPayload) ? findFirstString(modifyPayload) : null;
  const q = getNested(payload, [1, 0, 2]);
  const query = typeof q === 'string' ? q : null;
  const eta = getNested(payload, [2]);
  const etaText = typeof eta === 'string' ? eta : null;
  const cp = getNested(payload, [3, 0]);
  const confirmPrompt = typeof cp === 'string' ? cp : null;
  const cu = getNested(payload, [4, 0]);
  const confirmationUrl = typeof cu === 'string' ? cu : null;
  const rs = metaDict['70'];
  const rawState = typeof rs === 'number' ? rs : null;

  if (!(titleStr || query || steps.length || etaText || confirmPrompt || confirmationUrl || modifyPrompt)) {
    return null;
  }
  return {
    researchId,
    title: titleStr,
    query,
    steps,
    etaText,
    confirmPrompt,
    confirmationUrl,
    modifyPrompt,
    rawState,
    responseText: fallbackText || null,
    cid: null,
    metadata: [],
  };
}

/**
 * Walk parsed frames and return the first Deep Research plan found (or null), enriched
 * with the conversation cid + metadata (from frame `[1]`) needed to confirm/poll it. Pure.
 */
export function extractDeepResearchPlanFromFrames(frames: unknown[]): DeepResearchPlan | null {
  for (const part of frames) {
    const innerStr = getNested(part, [2]);
    if (typeof innerStr !== 'string') continue;
    let pj: unknown;
    try {
      pj = JSON.parse(innerStr);
    } catch {
      continue;
    }
    const meta = getNested(pj, [1], []) as unknown[];
    const cid = getNested(pj, [1, 0], null) as string | null;
    const candidates = getNested(pj, [4], []) as unknown[];
    if (!Array.isArray(candidates)) continue;
    for (const cand of candidates) {
      const text = getNested(cand, [1, 0], '');
      const plan = extractDeepResearchPlan(cand, typeof text === 'string' ? text : '');
      if (plan) {
        plan.cid = plan.cid ?? cid;
        plan.metadata = Array.isArray(meta) ? meta : [];
        return plan;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// batchexecute lane: Deep Research status polling + read-chat (final report).
// ---------------------------------------------------------------------------

/** A single RPC to batch-execute. */
export interface RpcCall {
  rpcid: string;
  /** JSON-serializable payload (serialized to a string in the request). */
  payload: unknown;
}

/** Serialize one RPC to the batchexecute inner form `[rpcid, payload, null, "generic"]`. */
export function serializeRpc(call: RpcCall): unknown[] {
  return [call.rpcid, JSON.stringify(call.payload), null, 'generic'];
}

/** Options for {@link buildBatchExecuteRequest}. */
export interface BatchExecuteOptions {
  rpcs: RpcCall[];
  accessToken: string;
  buildLabel?: string | null;
  sessionId?: string | null;
  language?: string | null;
  reqId?: number;
  sourcePath?: string;
}

/** Build a batchexecute POST (params + form). Verbatim shape from reference _batch_execute. */
export function buildBatchExecuteRequest(opts: BatchExecuteOptions): StreamGenerateRequest {
  const language = opts.language || 'en';
  const reqId = opts.reqId ?? Math.floor(10000 + Math.random() * 90000);
  const params: Record<string, string> = {
    rpcids: opts.rpcs.map((r) => r.rpcid).join(','),
    hl: language,
    _reqid: String(reqId),
    rt: 'c',
    'source-path': opts.sourcePath || '/app',
  };
  if (opts.buildLabel) params.bl = opts.buildLabel;
  if (opts.sessionId) params['f.sid'] = opts.sessionId;

  const headers: Record<string, string> = {
    ...GEMINI_HEADERS,
    // BATCH_EXEC model header + same-domain.
    'x-goog-ext-525001261-jspb': '[1,null,null,null,null,null,null,null,[4]]',
    'x-goog-ext-73010989-jspb': '[0]',
  };

  const form = {
    at: opts.accessToken,
    'f.req': JSON.stringify([opts.rpcs.map(serializeRpc)]),
  };
  return { url: GEMINI_ENDPOINTS.BATCH_EXEC, params, headers, form };
}

/** Status of a running Deep Research task. */
export interface DeepResearchStatus {
  researchId: string;
  /** 'running' | 'awaiting_confirmation' | 'completed'. */
  state: string;
  title: string | null;
  query: string | null;
  cid: string | null;
  notes: string[];
  done: boolean;
  rawState: number | null;
}

const CHAT_ID_RE = /\bc_[A-Za-z0-9_]+\b/;

function collectResearchNotes(data: unknown, exclude: Set<string>): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const it of iterNested(data)) {
    if (typeof it !== 'string') continue;
    const t = it.trim();
    if (!t || exclude.has(t) || seen.has(t) || /^https?:\/\//.test(t) || t.length < 12) continue;
    seen.add(t);
    notes.push(t);
    if (notes.length >= 12) break;
  }
  return notes;
}

/**
 * Parse a Deep Research status payload (one part body from the kwDCne response). Port of
 * the reference `extract_deep_research_status_payload`. Returns null if no research id.
 * SCAFFOLD: DR status indices are version-brittle.
 */
export function extractDeepResearchStatus(payload: unknown): DeepResearchStatus | null {
  const data =
    Array.isArray(payload) && payload.length && Array.isArray(payload[0]) ? payload[0] : payload;
  const researchId = findFirstMatch(data, UUID_RE);
  if (!researchId) return null;

  const t = getNested(data, [1, 4, 0]);
  const title = typeof t === 'string' ? t : null;
  const q = getNested(data, [1, 4, 1]);
  const query = typeof q === 'string' ? q : null;
  const c = getNested(data, [1, 3, 0]);
  const cid = (typeof c === 'string' ? c : null) ?? findFirstMatch(data, CHAT_ID_RE);
  const metaDict = findFirstDictKey(data, '70');
  const rawState = metaDict && typeof metaDict['70'] === 'number' ? (metaDict['70'] as number) : null;

  const markers: string[] = [];
  for (const it of iterNested(data)) if (typeof it === 'string' && it) markers.push(it);
  const done = markers.some((m) => m.includes('immersive_entry_chip'));
  const awaiting = markers.some((m) => m.includes('deep_research_confirmation_content'));
  const state = done ? 'completed' : awaiting ? 'awaiting_confirmation' : 'running';

  const exclude = new Set([title, query, researchId, cid].filter((s): s is string => typeof s === 'string'));
  const notes = collectResearchNotes(data, exclude);

  return { researchId, state, title, query, cid, notes, done, rawState };
}

/** DR capability probe RPCs + payloads (reference inspect_account_status). */
export const DR_CAPABILITY_PROBES: { name: string; rpcid: string; payload: unknown }[] = [
  { name: 'bootstrap', rpcid: GEMINI_RPC.DEEP_RESEARCH_BOOTSTRAP, payload: ['en', null, null, null, 4, null, null, [2, 4, 7, 15], null, [[5]]] },
  { name: 'model_state', rpcid: GEMINI_RPC.DEEP_RESEARCH_MODEL_STATE, payload: [[[1, 4], [6, 6], [1, 15]]] },
  { name: 'caps', rpcid: GEMINI_RPC.DEEP_RESEARCH_CAPS, payload: [] },
];

/**
 * From batchexecute frames, the reject code for a given rpcid: the matching `wrb.fr`
 * part's `[5][0]` (7 = rejected/ineligible). `present` is false if no part matched. Pure.
 */
export function extractRpcRejectCode(
  frames: unknown[],
  rpcid: string,
): { present: boolean; rejectCode: number | null } {
  for (const part of frames) {
    if (getNested(part, [0]) !== 'wrb.fr') continue;
    if (getNested(part, [1]) !== rpcid) continue;
    const code = getNested(part, [5, 0]);
    return { present: true, rejectCode: typeof code === 'number' ? code : null };
  }
  return { present: false, rejectCode: null };
}

/**
 * Decide Deep Research eligibility from a capability-probe batchexecute response: all
 * DR probes must be present with no reject code (reference `inspect_account_status`
 * summary). Returns which probes were rejected/absent. Pure.
 */
export function assessDeepResearchCapability(frames: unknown[]): { capable: boolean; rejected: string[] } {
  const rejected: string[] = [];
  for (const p of DR_CAPABILITY_PROBES) {
    const r = extractRpcRejectCode(frames, p.rpcid);
    if (!r.present || r.rejectCode !== null) rejected.push(p.name);
  }
  return { capable: rejected.length === 0, rejected };
}

/** Walk a batchexecute response's frames → first Deep Research status found (or null). */
export function extractDeepResearchStatusFromFrames(frames: unknown[]): DeepResearchStatus | null {
  for (const part of frames) {
    const bodyStr = getNested(part, [2]);
    if (typeof bodyStr !== 'string') continue;
    let body: unknown;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      continue;
    }
    const status = extractDeepResearchStatus(body);
    if (status) return status;
  }
  return null;
}

/**
 * Extract the latest model response text from a READ_CHAT batchexecute response. Turns are
 * newest-first, so the first model turn is the most recent reply. Port of the reference
 * read_chat model-turn parse. Returns '' if none. SCAFFOLD: read-chat indices are brittle.
 */
export function extractChatLatestModelText(frames: unknown[]): string {
  for (const part of frames) {
    const bodyStr = getNested(part, [2]);
    if (typeof bodyStr !== 'string') continue;
    let body: unknown;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      continue;
    }
    const turns = getNested(body, [0], []) as unknown[];
    if (!Array.isArray(turns)) continue;
    for (const turn of turns) {
      const candidates = getNested(turn, [3, 0], []) as unknown[];
      if (!Array.isArray(candidates)) continue;
      for (const cand of candidates) {
        const text = getNested(cand, [1, 0], '');
        if (typeof text === 'string' && text) return text;
      }
    }
  }
  return '';
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
  /** Request a Deep Research plan turn (sets the DR inner fields). */
  deepResearch?: boolean;
  /** Injectable DR nonce (inner[3]); defaults to a long random base64url token. */
  drToken?: string;
  /** Injectable DR uuid (inner[4]); defaults to a random hex uuid. */
  drUuid?: string;
  /** Conversation metadata (inner[2]) to continue an existing chat (e.g. a DR plan). */
  metadata?: unknown[];
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
  inner[2] = opts.metadata && opts.metadata.length ? opts.metadata : [...DEFAULT_METADATA];
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

  if (opts.deepResearch) {
    // DR nonce + selection flags, verbatim from reference client.py.
    inner[3] = '!' + (opts.drToken ?? randomBytes(2600).toString('base64url'));
    inner[4] = opts.drUuid ?? randomUUID().replace(/-/g, '');
    inner[49] = 1;
    inner[54] = [[[[[1]]]]];
    inner[55] = [[1]];
  }

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
