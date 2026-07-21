/**
 * @file grok-rag.ts
 * @description FREE document-grounded RAG on the $30 grok.com subscription seat,
 * via the app-chat FILE-ATTACH lane the web UI uses (PROVEN 2026-07-21).
 *
 * Distinct capability from the #911 managed-embedding collections (which are
 * retrieval-orphaned on the seat). Here the flow is:
 *   1. upload each doc  -> POST /rest/app-chat/upload-file (cookie-only, statsig-free)
 *   2. ask grounded     -> POST /rest/app-chat/conversations/new with
 *      fileAttachments:[<fileMetadataId>] and a FRESH x-statsig-id minted by the
 *      GrokStatsigOracle for THAT path; grok streams a grounded answer.
 *
 * Proof: uploading a doc with an invented fact and asking a question whose only
 * source is that doc returns the exact fact; the same question with NO file does
 * not know it. Grounded generation over the user's own docs IS free RAG.
 *
 * Reuses GW3 (session manager) + the GWV1 statsig oracle behind the shared
 * `SUDO_GROK_WEBSESSION` flag (default OFF). No new flag. Secrets never logged;
 * grok's returned text is DATA (a document answer), never instructions. The lane
 * is seat-covered — it never touches the metered api.x.ai (money safety).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { PROJECT_ROOT } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import type { GrokWebCreds } from './grok-web-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-rag');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_rag.py');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';
const HARD_TIMEOUT_MS = 180_000;
/** Reject uploads larger than this (per-doc) to keep the seat call sane. */
const MAX_DOC_BYTES = 25 * 1024 * 1024;
/** app-chat/conversations/new is the statsig-gated path we mint for. */
const CONV_NEW_PATH = '/rest/app-chat/conversations/new';

/** A document to attach: raw bytes plus a display name + mime. */
export interface GrokRagDoc {
  fileName: string;
  fileMimeType: string;
  /** base64-encoded document bytes. */
  contentB64: string;
}

/** Bridge request (secrets merged in separately, never logged). */
interface GrokRagBridgeRequest {
  op: 'rag';
  question: string;
  docs: GrokRagDoc[];
  modelName?: string;
  timeoutSec?: number;
}

export interface GrokRagBridgeResponse {
  ok: boolean;
  status?: number;
  errorClass?: string;
  detail?: string;
  answer?: string;
  conversationId?: string | null;
  fileIds?: string[];
  attachmentsPreprocessed?: boolean;
}

export class GrokRagError extends Error {
  readonly errorClass: string;
  readonly status?: number;
  constructor(errorClass: string, message: string, status?: number) {
    super(message);
    this.name = 'GrokRagError';
    this.errorClass = errorClass;
    if (status !== undefined) this.status = status;
  }
}

export interface GrokRagDeps {
  manager: GrokWebSessionManager;
  /** Spawns grok_rag.py; injectable so tests need no network. */
  bridge: (req: GrokRagBridgeRequest, creds: GrokWebCreds) => Promise<GrokRagBridgeResponse>;
  /** Mints a fresh x-statsig-id for a path; injectable so tests need no browser. */
  mint: (reqPath: string, method: string) => Promise<string>;
}

export interface GrokRagInput {
  question: string;
  /** Local file paths to upload (read + validated here). */
  files?: string[];
  /** Inline text documents (auto-named doc-N.txt). */
  texts?: string[];
  /** Override the answering model (default grok-4). */
  modelName?: string;
}

export interface GrokRagResult {
  answer: string;
  conversationId?: string | null;
  fileIds?: string[];
}

// ---------------------------------------------------------------------------
// Default seams
// ---------------------------------------------------------------------------

/**
 * Mint a fresh x-statsig-id via the GWV1 oracle, retrying on a null/failed mint
 * (the mint reads a live render fingerprint and is occasionally null on a busy
 * warm page). Attaches to a managed warm browser (GWV6) or an external one via
 * SUDO_GROK_ORACLE_CDP_URL — a page dedicated to grok, not the hot path.
 */
function makeOracleMint(profileDir?: string): (reqPath: string, method: string) => Promise<string> {
  return async (reqPath: string, method: string): Promise<string> => {
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
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const token = await oracle.mint(reqPath, method);
        if (token) return token;
      } catch (err) {
        lastErr = err;
        log.info({ attempt }, 'grok-rag statsig mint retry');
      }
    }
    throw new GrokRagError(
      'statsig',
      `grok-rag: could not mint an x-statsig-id after 3 attempts${
        lastErr instanceof Error ? ` (${lastErr.message})` : ''
      }`,
    );
  };
}

/** Default bridge: spawn grok_rag.py, one JSON in / one JSON out (clone of GW2). */
function defaultBridge(
  req: GrokRagBridgeRequest,
  creds: GrokWebCreds,
): Promise<GrokRagBridgeResponse> {
  const timeoutMs = Math.min(
    typeof req.timeoutSec === 'number' ? req.timeoutSec * 1000 + 15_000 : HARD_TIMEOUT_MS,
    HARD_TIMEOUT_MS,
  );
  return new Promise<GrokRagBridgeResponse>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const settle = (r: GrokRagBridgeResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    const timer = setTimeout(() => {
      settle({ ok: false, errorClass: 'timeout', detail: `bridge timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err: Error) => {
      settle({ ok: false, errorClass: 'bridge_error', detail: `spawn failed: ${err.message}` });
    });
    child.on('close', (code: number | null) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      try {
        settle(JSON.parse(line) as GrokRagBridgeResponse);
      } catch {
        settle({
          ok: false,
          errorClass: 'bridge_error',
          detail: `no JSON from bridge (exit ${code}); stderr: ${stderr.slice(0, 200)}`,
        });
      }
    });
    // Secrets go in ONLY here, on stdin. Never logged.
    try {
      child.stdin?.write(JSON.stringify({ ...req, ...creds }));
      child.stdin?.end();
    } catch (err) {
      settle({ ok: false, errorClass: 'bridge_error', detail: `stdin write failed: ${String(err)}` });
    }
  });
}

function defaultDeps(profileDir?: string): GrokRagDeps {
  return { manager: getGrokWebSessionManager(), bridge: defaultBridge, mint: makeOracleMint(profileDir) };
}

function credsOf(session: { cookie: string; userAgent: string }): GrokWebCreds {
  return { cookie: session.cookie, userAgent: session.userAgent };
}

async function ready(deps: GrokRagDeps): Promise<{ cookie: string; userAgent: string; profileDir?: string }> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  return deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
}

const TEXT_EXT_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
};

/** Read a local file into a GrokRagDoc, validating it is a regular file <= cap. */
async function readDoc(filePath: string): Promise<GrokRagDoc> {
  const resolved = path.resolve(filePath);
  let st;
  try {
    st = await stat(resolved);
  } catch {
    throw new TypeError(`grokRagQuery: cannot read file "${filePath}"`);
  }
  if (!st.isFile()) throw new TypeError(`grokRagQuery: not a regular file "${filePath}"`);
  if (st.size > MAX_DOC_BYTES) {
    throw new TypeError(`grokRagQuery: file "${filePath}" exceeds ${MAX_DOC_BYTES} bytes`);
  }
  const bytes = await readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  return {
    fileName: basename(resolved),
    fileMimeType: TEXT_EXT_MIME[ext] ?? 'application/octet-stream',
    contentB64: bytes.toString('base64'),
  };
}

/**
 * Ask a question grounded in one or more documents, FREE on the subscription
 * seat. Uploads each doc through the app-chat file-attach lane and returns the
 * grounded answer. Throws `TypeError` on bad input and `GrokRagError` (with an
 * `errorClass`) on any lane failure — it never falls back to a paid API.
 */
export async function grokRagQuery(
  input: GrokRagInput,
  opts: { deps?: GrokRagDeps } = {},
): Promise<GrokRagResult> {
  const question = (input.question ?? '').trim();
  if (!question) throw new TypeError('grokRagQuery: question must be a non-empty string');

  const docs: GrokRagDoc[] = [];
  for (const p of input.files ?? []) docs.push(await readDoc(p));
  (input.texts ?? []).forEach((text, i) => {
    const t = typeof text === 'string' ? text : '';
    if (t.trim() !== '') {
      docs.push({
        fileName: `doc-${i + 1}.txt`,
        fileMimeType: 'text/plain',
        contentB64: Buffer.from(t, 'utf8').toString('base64'),
      });
    }
  });
  if (docs.length === 0) {
    throw new TypeError('grokRagQuery: provide at least one file or non-empty text');
  }

  const deps = opts.deps ?? defaultDeps();
  const session = await ready(deps);

  let statsigId: string;
  try {
    statsigId = await deps.mint(CONV_NEW_PATH, 'POST');
  } catch (err) {
    if (err instanceof GrokRagError) throw err;
    throw new GrokRagError('statsig', `grok-rag: statsig mint failed (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!statsigId) throw new GrokRagError('statsig', 'grok-rag: statsig mint returned no token');

  const r = await deps.bridge(
    {
      op: 'rag',
      question,
      docs,
      ...(input.modelName ? { modelName: input.modelName } : {}),
    },
    { ...credsOf(session), statsigId },
  );
  if (!r.ok || !r.answer) {
    throw new GrokRagError(
      r.errorClass ?? 'unknown',
      `grok-rag failed: ${r.errorClass ?? 'no answer'}${r.detail ? ` (${r.detail})` : ''}`,
      r.status,
    );
  }
  log.info(
    { docs: docs.length, answerLen: r.answer.length, preprocessed: r.attachmentsPreprocessed === true },
    'grok-rag grounded answer',
  );
  return {
    answer: r.answer,
    conversationId: r.conversationId ?? null,
    ...(r.fileIds ? { fileIds: r.fileIds } : {}),
  };
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
