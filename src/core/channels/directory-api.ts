/**
 * @file directory-api.ts
 * @description Unified Directory HTTP API for the web-chat SPA — one feed for
 * all three catalogs (Skills / Connectors / Plugins) plus an install action.
 * Mounted by the WebAdapter under the same WEB_CHAT_TOKEN auth as /api/message.
 *
 *   GET  /api/directory              -> { skills[], connectors[], plugins[], sources, errors }
 *   POST /api/directory/install      -> { kind, name, dryRun? } dispatched to the
 *                                       matching *.install tool; returns its result.
 *
 * Reads are fail-soft per-catalog (one unreachable registry doesn't blank the
 * others). Installs reuse the exact agent tools (skill.install / connector.install
 * / plugin.install), so the same gates (Workshop, mcp.connect) apply.
 */

import type http from 'node:http';
import { createLogger } from '../shared/logger.js';
import type { ToolContext } from '../tools/types.js';
import { SkillRegistryClient } from '../skills/registry-client.js';
import { ConnectorRegistryClient } from '../skills/connector-registry-client.js';
import { PluginRegistryClient } from '../skills/plugin-registry-client.js';
import { installTool as skillInstallTool } from '../tools/builtin/skill/tools/install.js';
import { connectorInstallTool } from '../tools/builtin/meta/connector-registry.js';
import { pluginInstallTool } from '../tools/builtin/meta/plugin-registry.js';

const log = createLogger('channels:directory-api');

const DIRECTORY_PATHS = new Set(['/api/directory', '/api/directory/install']);

/** True when this adapter should own the request path (so web.ts can delegate). */
export function isDirectoryPath(url: string): boolean {
  return DIRECTORY_PATHS.has(url);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, maxBytes = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      total += chunk.byteLength;
      if (total > maxBytes) { over = true; reject(new Error('payload too large')); req.destroy(); return; }
      body += chunk.toString();
    });
    req.on('end', () => { if (!over) resolve(body); });
    req.on('error', reject);
  });
}

/** Minimal ToolContext for a web-triggered install. */
function directoryToolContext(): ToolContext {
  return {
    sessionId: 'web:directory',
    workingDir: process.cwd(),
    config: {},
    logger: log,
  };
}

async function getCatalogs(): Promise<{
  skills: unknown[];
  connectors: unknown[];
  plugins: unknown[];
  sources: Record<string, string | null>;
  errors: Record<string, string>;
}> {
  const errors: Record<string, string> = {};
  const sources: Record<string, string | null> = { skills: null, connectors: null, plugins: null };

  const [skillsRes, connectorsRes, pluginsRes] = await Promise.allSettled([
    new SkillRegistryClient().fetchIndex(),
    new ConnectorRegistryClient().fetchIndex(),
    new PluginRegistryClient().fetchIndex(),
  ]);

  let skills: unknown[] = [];
  let connectors: unknown[] = [];
  let plugins: unknown[] = [];

  if (skillsRes.status === 'fulfilled') { skills = skillsRes.value.index.skills; sources['skills'] = skillsRes.value.sourceUrl; }
  else errors['skills'] = skillsRes.reason instanceof Error ? skillsRes.reason.message : String(skillsRes.reason);

  if (connectorsRes.status === 'fulfilled') { connectors = connectorsRes.value.index.connectors; sources['connectors'] = connectorsRes.value.sourceUrl; }
  else errors['connectors'] = connectorsRes.reason instanceof Error ? connectorsRes.reason.message : String(connectorsRes.reason);

  if (pluginsRes.status === 'fulfilled') { plugins = pluginsRes.value.index.plugins; sources['plugins'] = pluginsRes.value.sourceUrl; }
  else errors['plugins'] = pluginsRes.reason instanceof Error ? pluginsRes.reason.message : String(pluginsRes.reason);

  return { skills, connectors, plugins, sources, errors };
}

/**
 * Handle a Directory request. Returns true if it owned the request (auth is
 * enforced by the caller before delegating).
 */
export async function handleDirectoryRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (!isDirectoryPath(url)) return false;

  if (method === 'GET' && url === '/api/directory') {
    try {
      const catalogs = await getCatalogs();
      sendJson(res, 200, { ok: true, ...catalogs });
    } catch (err) {
      log.error({ err }, 'GET /api/directory failed');
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (method === 'POST' && url === '/api/directory/install') {
    let parsed: { kind?: string; name?: string; dryRun?: boolean };
    try {
      parsed = JSON.parse(await readBody(req)) as typeof parsed;
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid body' });
      return true;
    }
    const kind = String(parsed.kind ?? '');
    const name = String(parsed.name ?? '');
    const dryRun = parsed.dryRun === true; // default false: the UI's Add button installs
    if (!name || !['skill', 'connector', 'plugin'].includes(kind)) {
      sendJson(res, 400, { ok: false, error: 'body needs { kind: "skill"|"connector"|"plugin", name }' });
      return true;
    }
    const ctx = directoryToolContext();
    const params: Record<string, unknown> = { name, dryRun };
    try {
      log.info({ kind, name, dryRun }, 'Directory install requested');
      const result = kind === 'skill'
        ? await skillInstallTool.execute(params, ctx)
        : kind === 'connector'
          ? await connectorInstallTool.execute(params, ctx)
          : await pluginInstallTool.execute(params, ctx);
      sendJson(res, result.success ? 200 : 400, {
        ok: result.success,
        kind,
        name,
        dryRun,
        output: result.output,
        data: result.data ?? null,
      });
    } catch (err) {
      log.error({ kind, name, err }, 'Directory install failed');
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}
