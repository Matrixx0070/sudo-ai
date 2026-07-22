/**
 * @file grok-workspaces.ts
 * @description READ-ONLY access to grok.com workspaces on the FREE $30
 * subscription seat (cookie-only, statsig-FREE — probed live 2026-07-22):
 *
 *   list          -> GET /rest/workspaces (+ /rest/workspaces/shared)
 *   detail        -> GET /rest/workspaces/{id} (+ connectors/collections/
 *                    permissions/computer-root access side-reads)
 *   files         -> GET /rest/workspaces/{id}/files?path&recursive
 *   file content  -> GET /rest/workspaces/{id}/files/content?path
 *                    (signed-URL metadata; optional byte download)
 *
 * HONEST LIMITS (probed live 2026-07-22): the current seat owns ZERO
 * workspaces ({"workspaces":[]} on both list lanes), so the per-id readers are
 * contract-verified against the app bundle's workspaceRepository* client plus
 * live 404 "Workspace not found or access denied" probes (auth + method
 * proven), not against a populated workspace. V1 deliberately wires NO write
 * op (create/upload/mkdir/move/delete/set-computer-root all exist server-side
 * but are untouched — see grok_workspaces.py header).
 *
 * Reuses GW3 (session manager) behind the shared `SUDO_GROK_WEBSESSION` flag
 * (default OFF). No new flag, no statsig mint needed. Secrets ride stdin into
 * the python bridge only and are never logged. The lane is seat-covered — it
 * never touches the metered api.x.ai (money safety). Downloaded bytes come
 * back base64 over the bridge (signed-URL host allow-listed python-side);
 * remote paths are traversal-checked here before any caller writes to disk.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import type { GrokWebCreds } from './grok-web-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';

const log = createLogger('llm:grok-workspaces');

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'grok-web', 'grok_workspaces.py');
const PYTHON_BIN = process.env['SUDO_GROK_WEB_PYTHON'] ?? 'python3';
const HARD_TIMEOUT_MS = 120_000;
/** workspaceId is a UUID; validate before it ever reaches a URL path. */
const WORKSPACE_ID_RE = /^[0-9a-fA-F-]{32,40}$/;

/** Workspace summary/detail (bundle mapper shape; extra keys pass through). */
export interface GrokWorkspace {
  workspaceId: string;
  name?: string;
  createTime?: string;
  lastUseTime?: string;
  icon?: string;
  customPersonality?: string;
  preferredModel?: string;
  isPublic?: boolean;
  isReadonly?: boolean;
  accessLevel?: string;
  [k: string]: unknown;
}

/** One entry of a workspace file listing (bundle mapper shape). */
export interface GrokWorkspaceFile {
  path?: string;
  name?: string;
  isDirectory?: boolean;
  size?: number | string;
  mimeType?: string;
  createdAt?: string;
  modifiedAt?: string;
  assetId?: string;
}

/** Signed-URL metadata for one workspace file's content. */
export interface GrokWorkspaceFileContent {
  signedUrl?: string;
  downloadSignedUrl?: string;
  expiresAt?: string;
  mimeType?: string;
  size?: number | string;
}

/** The workspace "computer" filesystem-root binding (access state). */
export interface GrokComputerRootAccess {
  state?: string;
  provider?: string;
}

export interface GrokWorkspaceDetail {
  workspace: GrokWorkspace;
  connectorIds: string[];
  collectionIds: string[];
  permissions: Record<string, unknown> | null;
  computerRoot: GrokComputerRootAccess | null;
}

/** Bridge request (secrets merged in separately, never logged). */
export interface GrokWorkspacesBridgeRequest {
  op: 'list' | 'detail' | 'files' | 'file_content';
  shared?: boolean;
  pageSize?: number;
  pageToken?: string;
  workspaceId?: string;
  path?: string;
  recursive?: boolean;
  download?: boolean;
  timeoutSec?: number;
}

export interface GrokWorkspacesBridgeResponse {
  ok: boolean;
  status?: number;
  errorClass?: string;
  detail?: string;
  // op=list
  workspaces?: GrokWorkspace[];
  nextPageToken?: string;
  // op=detail
  workspace?: GrokWorkspace;
  connectorIds?: string[];
  collectionIds?: string[];
  permissions?: Record<string, unknown> | null;
  computerRoot?: GrokComputerRootAccess | null;
  // op=files
  files?: GrokWorkspaceFile[];
  path?: string;
  // op=file_content
  content?: GrokWorkspaceFileContent;
  contentB64?: string;
}

export class GrokWorkspacesError extends Error {
  readonly errorClass: string;
  readonly status?: number;
  constructor(errorClass: string, message: string, status?: number) {
    super(message);
    this.name = 'GrokWorkspacesError';
    this.errorClass = errorClass;
    if (status !== undefined) this.status = status;
  }
}

export interface GrokWorkspacesDeps {
  manager: GrokWebSessionManager;
  /** Spawns grok_workspaces.py; injectable so tests need no network. */
  bridge: (
    req: GrokWorkspacesBridgeRequest,
    creds: GrokWebCreds,
  ) => Promise<GrokWorkspacesBridgeResponse>;
}

// ---------------------------------------------------------------------------
// Default seams (clone of the grok-files bridge spawn)
// ---------------------------------------------------------------------------

function defaultBridge(
  req: GrokWorkspacesBridgeRequest,
  creds: GrokWebCreds,
): Promise<GrokWorkspacesBridgeResponse> {
  const timeoutMs = Math.min(
    typeof req.timeoutSec === 'number' ? req.timeoutSec * 1000 + 15_000 : HARD_TIMEOUT_MS,
    HARD_TIMEOUT_MS,
  );
  return new Promise<GrokWorkspacesBridgeResponse>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const settle = (r: GrokWorkspacesBridgeResponse): void => {
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
        const parsed = JSON.parse(line) as GrokWorkspacesBridgeResponse;
        log.debug(
          { op: req.op, ok: parsed.ok, status: parsed.status, errorClass: parsed.errorClass },
          'grok-workspaces bridge result',
        );
        settle(parsed);
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

function defaultDeps(): GrokWorkspacesDeps {
  return { manager: getGrokWebSessionManager(), bridge: defaultBridge };
}

async function ready(deps: GrokWorkspacesDeps): Promise<GrokWebCreds> {
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();
  const session = await deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
  return { cookie: session.cookie, userAgent: session.userAgent };
}

async function call(
  deps: GrokWorkspacesDeps,
  req: GrokWorkspacesBridgeRequest,
): Promise<GrokWorkspacesBridgeResponse> {
  const creds = await ready(deps);
  const r = await deps.bridge(req, creds);
  if (!r.ok) {
    throw new GrokWorkspacesError(
      r.errorClass ?? 'unknown',
      `grok-workspaces ${req.op} failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`,
      r.status,
    );
  }
  return r;
}

function assertWorkspaceId(workspaceId: string, fn: string): string {
  const id = (workspaceId ?? '').trim();
  if (!id || !WORKSPACE_ID_RE.test(id)) {
    throw new TypeError(`${fn}: workspaceId must be a UUID-shaped string`);
  }
  return id;
}

/**
 * A workspace-relative file path used in a query string. Rejects traversal
 * (`..` segments) and absolute/backslash forms so a remote path can never be
 * abused later as a local write location either.
 */
function assertRemotePath(remotePath: string, fn: string): string {
  const p = (remotePath ?? '').trim();
  if (!p) throw new TypeError(`${fn}: path must be a non-empty string`);
  if (p.includes('\\') || p.split('/').some((seg) => seg === '..')) {
    throw new TypeError(`${fn}: path must not contain ".." segments or backslashes`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Capability functions (all READ-ONLY — V1 wires no workspace mutation)
// ---------------------------------------------------------------------------

/**
 * List workspaces on the seat (owned by default; `shared:true` lists
 * workspaces shared with the account). FREE, statsig-free, cookie lane.
 */
export async function listGrokWorkspaces(
  opts: { shared?: boolean; pageSize?: number; pageToken?: string; deps?: GrokWorkspacesDeps } = {},
): Promise<{ workspaces: GrokWorkspace[]; nextPageToken: string }> {
  const req: GrokWorkspacesBridgeRequest = { op: 'list' };
  if (opts.shared) req.shared = true;
  if (opts.pageSize !== undefined) req.pageSize = opts.pageSize;
  if (opts.pageToken !== undefined) req.pageToken = opts.pageToken;
  const r = await call(opts.deps ?? defaultDeps(), req);
  if (!Array.isArray(r.workspaces)) {
    throw new GrokWorkspacesError('bad_response', 'grok-workspaces list: no workspaces array');
  }
  log.info({ count: r.workspaces.length, shared: opts.shared === true }, 'grok workspaces listed');
  return { workspaces: r.workspaces, nextPageToken: r.nextPageToken ?? '' };
}

/**
 * Fetch one workspace plus its readable surroundings: active connector +
 * collection ids, the permissions block and the computer-root access state.
 */
export async function getGrokWorkspace(
  workspaceId: string,
  opts: { deps?: GrokWorkspacesDeps } = {},
): Promise<GrokWorkspaceDetail> {
  const id = assertWorkspaceId(workspaceId, 'getGrokWorkspace');
  const r = await call(opts.deps ?? defaultDeps(), { op: 'detail', workspaceId: id });
  if (!r.workspace) {
    throw new GrokWorkspacesError('bad_response', 'grok-workspaces detail: no workspace in response');
  }
  return {
    workspace: r.workspace,
    connectorIds: r.connectorIds ?? [],
    collectionIds: r.collectionIds ?? [],
    permissions: r.permissions ?? null,
    computerRoot: r.computerRoot ?? null,
  };
}

/** The workspace "computer" filesystem-root access state (read lane only). */
export async function getGrokComputerRoot(
  workspaceId: string,
  opts: { deps?: GrokWorkspacesDeps } = {},
): Promise<GrokComputerRootAccess | null> {
  return (await getGrokWorkspace(workspaceId, opts)).computerRoot;
}

/** List a workspace's files (optionally under `path`, optionally recursive). */
export async function listGrokWorkspaceFiles(
  workspaceId: string,
  opts: { path?: string; recursive?: boolean; deps?: GrokWorkspacesDeps } = {},
): Promise<{ files: GrokWorkspaceFile[]; path: string }> {
  const id = assertWorkspaceId(workspaceId, 'listGrokWorkspaceFiles');
  const req: GrokWorkspacesBridgeRequest = { op: 'files', workspaceId: id };
  if (opts.path !== undefined) req.path = assertRemotePath(opts.path, 'listGrokWorkspaceFiles');
  if (opts.recursive) req.recursive = true;
  const r = await call(opts.deps ?? defaultDeps(), req);
  if (!Array.isArray(r.files)) {
    throw new GrokWorkspacesError('bad_response', 'grok-workspaces files: no files array');
  }
  log.info({ count: r.files.length }, 'grok workspace files listed');
  return { files: r.files, path: r.path ?? '' };
}

/** Signed-URL metadata for one workspace file (no bytes fetched). */
export async function getGrokWorkspaceFileContent(
  workspaceId: string,
  remotePath: string,
  opts: { deps?: GrokWorkspacesDeps } = {},
): Promise<GrokWorkspaceFileContent> {
  const id = assertWorkspaceId(workspaceId, 'getGrokWorkspaceFileContent');
  const p = assertRemotePath(remotePath, 'getGrokWorkspaceFileContent');
  const r = await call(opts.deps ?? defaultDeps(), { op: 'file_content', workspaceId: id, path: p });
  if (!r.content) {
    throw new GrokWorkspacesError('bad_response', 'grok-workspaces file_content: no content block');
  }
  return r.content;
}

/**
 * Download one workspace file's bytes. The python bridge only fetches signed
 * URLs on grok.com / *.grok.com hosts (allow-list); the remote path is
 * traversal-checked here. Callers (CLI) confine the local write location.
 */
export async function downloadGrokWorkspaceFile(
  workspaceId: string,
  remotePath: string,
  opts: { deps?: GrokWorkspacesDeps } = {},
): Promise<{ content: Buffer; meta: GrokWorkspaceFileContent }> {
  const id = assertWorkspaceId(workspaceId, 'downloadGrokWorkspaceFile');
  const p = assertRemotePath(remotePath, 'downloadGrokWorkspaceFile');
  const r = await call(opts.deps ?? defaultDeps(), {
    op: 'file_content',
    workspaceId: id,
    path: p,
    download: true,
  });
  if (!r.content || typeof r.contentB64 !== 'string') {
    throw new GrokWorkspacesError('bad_response', 'grok-workspaces download: missing content bytes');
  }
  const content = Buffer.from(r.contentB64, 'base64');
  log.info({ bytes: content.length }, 'grok workspace file downloaded');
  return { content, meta: r.content };
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
