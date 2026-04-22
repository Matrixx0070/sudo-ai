/**
 * @file admin/tools.handler.ts
 * @description Admin API handlers for tool management.
 *
 * Routes registered:
 *   GET  /api/admin/tools                 — List all tools with metadata
 *   POST /api/admin/tools/:name/toggle    — Enable / disable a tool
 *   GET  /api/admin/tools/stats           — Usage stats per tool (placeholder)
 *   PUT  /api/admin/tools/browser-config  — Update browser tool config section
 *
 * Filesystem helpers live in tools-helpers.ts.
 */

import { adminRouter, sendJson, readJsonBody } from '../admin-router.js';
import { readConfig, writeConfig } from './config-io.js';
import {
  listToolsFromFilesystem,
  getDisabledTools,
  setDisabledTools,
  ALLOWED_BROWSER_KEYS,
} from './tools-helpers.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin:tools');

// ---------------------------------------------------------------------------
// GET /api/admin/tools
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/tools', async (_req, res) => {
  log.debug('GET /api/admin/tools');

  const allTools = listToolsFromFilesystem();
  const disabledSet = new Set(getDisabledTools());

  const categories: Record<string, { count: number; disabled: number }> = {};
  const toolList = allTools.map((t) => {
    const isDisabled = disabledSet.has(t.name);
    if (!categories[t.category]) {
      categories[t.category] = { count: 0, disabled: 0 };
    }
    categories[t.category]!.count++;
    if (isDisabled) categories[t.category]!.disabled++;

    return { name: t.name, category: t.category, file: t.file, enabled: !isDisabled };
  });

  sendJson(res, 200, {
    tools: toolList,
    total: toolList.length,
    enabled: toolList.filter((t) => t.enabled).length,
    disabled: toolList.filter((t) => !t.enabled).length,
    categories: Object.entries(categories).map(([name, stats]) => ({ name, ...stats })),
  });

  log.debug({ total: toolList.length }, 'tools list served');
});

// ---------------------------------------------------------------------------
// POST /api/admin/tools/:name/toggle
// ---------------------------------------------------------------------------

adminRouter.post('/api/admin/tools/:name/toggle', async (req, res, params) => {
  const rawName = params['name'];
  if (!rawName) {
    sendJson(res, 400, { error: { message: 'Tool name param missing', code: 400 } });
    return;
  }

  // Reconstruct dotted name from full URL path since :name captures one segment.
  const url = (req.url ?? '').split('?')[0] ?? '';
  const match = url.match(/^\/api\/admin\/tools\/(.+)\/toggle$/);
  const toolName = match?.[1] ?? rawName;

  log.debug({ toolName }, 'POST /api/admin/tools/:name/toggle');

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    log.warn({ err, toolName }, 'toggle: invalid request body');
    sendJson(res, 400, { error: { message: 'Invalid JSON body', code: 400 } });
    return;
  }

  const currentDisabled = getDisabledTools();
  const currentlyDisabled = currentDisabled.includes(toolName);

  // Honour explicit `enabled` field; otherwise toggle.
  const newEnabled: boolean =
    typeof body['enabled'] === 'boolean' ? body['enabled'] : currentlyDisabled;

  let updatedDisabled: string[];
  if (newEnabled) {
    updatedDisabled = currentDisabled.filter((n) => n !== toolName);
  } else {
    updatedDisabled = currentlyDisabled ? currentDisabled : [...currentDisabled, toolName];
  }

  try {
    setDisabledTools(updatedDisabled);
  } catch (err) {
    log.error({ err, toolName }, 'toggle: failed to write config');
    sendJson(res, 500, { error: { message: 'Failed to update config', code: 500 } });
    return;
  }

  log.info({ toolName, enabled: newEnabled }, 'Tool toggled');
  sendJson(res, 200, { tool: toolName, enabled: newEnabled });
});

// ---------------------------------------------------------------------------
// GET /api/admin/tools/stats
// ---------------------------------------------------------------------------

adminRouter.get('/api/admin/tools/stats', async (_req, res) => {
  log.debug('GET /api/admin/tools/stats');

  // Placeholder — real stats require an execution log table.
  const allTools = listToolsFromFilesystem();
  const stats = allTools.map((t) => ({
    name: t.name,
    category: t.category,
    callsToday: 0,
    callsTotal: 0,
    avgDurationMs: 0,
    lastUsed: null,
    errorRate: 0,
  }));

  sendJson(res, 200, {
    stats,
    note: 'Live stats require execution log DB — showing defaults',
  });

  log.debug({ toolCount: stats.length }, 'tool stats served');
});

// ---------------------------------------------------------------------------
// PUT /api/admin/tools/browser-config
// ---------------------------------------------------------------------------

adminRouter.put('/api/admin/tools/browser-config', async (req, res) => {
  log.debug('PUT /api/admin/tools/browser-config');

  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    log.warn({ err }, 'browser-config: invalid JSON body');
    sendJson(res, 400, { error: { message: 'Invalid JSON body', code: 400 } });
    return;
  }

  if (!body || typeof body !== 'object') {
    sendJson(res, 400, { error: { message: 'Request body must be an object', code: 400 } });
    return;
  }

  let config: Record<string, unknown>;
  try {
    config = readConfig();
  } catch (err) {
    log.error({ err }, 'browser-config: failed to read config');
    sendJson(res, 500, { error: { message: 'Cannot read config', code: 500 } });
    return;
  }

  const tools = (config['tools'] as Record<string, unknown>) ?? {};
  const existing = (tools['browser'] as Record<string, unknown>) ?? {};
  const updated: Record<string, unknown> = { ...existing };

  for (const key of ALLOWED_BROWSER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      updated[key] = body[key];
    }
  }

  tools['browser'] = updated;
  config['tools'] = tools;

  try {
    writeConfig(config);
  } catch (err) {
    log.error({ err }, 'browser-config: failed to write config');
    sendJson(res, 500, { error: { message: 'Failed to save config', code: 500 } });
    return;
  }

  log.info({ keys: Object.keys(updated) }, 'Browser config updated');
  sendJson(res, 200, { browser: updated });
});
