/**
 * @file settings.handler.ts
 * @description Admin API handlers for the /api/admin/settings/* endpoints.
 *
 * Routes registered (override stubs in admin-router.ts):
 *   GET  /api/admin/settings
 *   PUT  /api/admin/settings/meta
 *   PUT  /api/admin/settings/agents
 *   PUT  /api/admin/settings/gateway
 *   GET  /api/admin/settings/personas
 *   PUT  /api/admin/settings/persona
 */

import { adminRouter, sendJson, readJsonBody } from '../admin-router.js';
import { readConfig, writeConfig } from './config-io.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin:settings');


interface Persona {
  id: string;
  name: string;
  description: string;
}

const PERSONAS: Persona[] = [
  { id: 'assistant', name: 'Assistant',  description: 'Helpful and professional' },
  { id: 'creative',  name: 'Creative',   description: 'Artistic and imaginative' },
  { id: 'technical', name: 'Technical',  description: 'Precise and analytical' },
  { id: 'casual',    name: 'Casual',     description: 'Friendly and relaxed' },
  { id: 'mentor',    name: 'Mentor',     description: 'Teaching and guiding' },
  { id: 'executive', name: 'Executive',  description: 'Strategic and decisive' },
];

const PERSONA_IDS = new Set(PERSONAS.map(p => p.id));

// --- GET /api/admin/settings ------------------------------------------------

adminRouter.get('/api/admin/settings', async (_req, res) => {
  log.debug('GET /api/admin/settings');
  try {
    const config = readConfig();
    sendJson(res, 200, { status: 'ok', data: config });
  } catch (err) {
    log.error({ err }, 'GET settings failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});

// --- PUT /api/admin/settings/meta -------------------------------------------

adminRouter.put('/api/admin/settings/meta', async (req, res) => {
  log.debug('PUT /api/admin/settings/meta');

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: (err as Error).message, code: 400 } });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }

  const update = body as Record<string, unknown>;

  // Validate accepted fields
  if ('name' in update) {
    if (typeof update['name'] !== 'string' || (update['name'] as string).trim() === '') {
      sendJson(res, 400, { error: { message: '"name" must be a non-empty string', code: 400 } });
      return;
    }
    update['name'] = (update['name'] as string).trim();
  }

  if ('timezone' in update) {
    if (typeof update['timezone'] !== 'string' || (update['timezone'] as string).trim() === '') {
      sendJson(res, 400, { error: { message: '"timezone" must be a non-empty string', code: 400 } });
      return;
    }
    update['timezone'] = (update['timezone'] as string).trim();
  }

  // Reject unknown keys
  const allowedKeys = new Set(['name', 'timezone']);
  const unknownKeys = Object.keys(update).filter(k => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    sendJson(res, 400, { error: { message: `Unknown meta fields: ${unknownKeys.join(', ')}`, code: 400 } });
    return;
  }

  try {
    const config = readConfig();
    const existing = (config['meta'] ?? {}) as Record<string, unknown>;
    config['meta'] = { ...existing, ...update };
    writeConfig(config);
    log.info({ keys: Object.keys(update) }, 'Settings meta updated');
    sendJson(res, 200, { status: 'ok', data: config['meta'] });
  } catch (err) {
    log.error({ err }, 'PUT settings/meta failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});

// --- PUT /api/admin/settings/agents -----------------------------------------

adminRouter.put('/api/admin/settings/agents', async (req, res) => {
  log.debug('PUT /api/admin/settings/agents');

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: (err as Error).message, code: 400 } });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }

  const update = body as Record<string, unknown>;

  if ('maxIterations' in update) {
    const v = update['maxIterations'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 200) {
      sendJson(res, 400, { error: { message: '"maxIterations" must be an integer between 1 and 200', code: 400 } });
      return;
    }
  }

  if ('systemPrompt' in update) {
    if (typeof update['systemPrompt'] !== 'string' || (update['systemPrompt'] as string).trim() === '') {
      sendJson(res, 400, { error: { message: '"systemPrompt" must be a non-empty string', code: 400 } });
      return;
    }
  }

  const allowedKeys = new Set(['maxIterations', 'systemPrompt']);
  const unknownKeys = Object.keys(update).filter(k => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    sendJson(res, 400, { error: { message: `Unknown agents fields: ${unknownKeys.join(', ')}`, code: 400 } });
    return;
  }

  try {
    const config = readConfig();
    const existing = (config['agents'] ?? {}) as Record<string, unknown>;
    config['agents'] = { ...existing, ...update };
    writeConfig(config);
    log.info({ keys: Object.keys(update) }, 'Settings agents updated');
    sendJson(res, 200, { status: 'ok', data: config['agents'] });
  } catch (err) {
    log.error({ err }, 'PUT settings/agents failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});

// --- PUT /api/admin/settings/gateway ----------------------------------------

adminRouter.put('/api/admin/settings/gateway', async (req, res) => {
  log.debug('PUT /api/admin/settings/gateway');

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: (err as Error).message, code: 400 } });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }

  const update = body as Record<string, unknown>;

  if ('enabled' in update && typeof update['enabled'] !== 'boolean') {
    sendJson(res, 400, { error: { message: '"enabled" must be a boolean', code: 400 } });
    return;
  }

  if ('port' in update) {
    const p = update['port'];
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1024 || p > 65535) {
      sendJson(res, 400, { error: { message: '"port" must be an integer between 1024 and 65535', code: 400 } });
      return;
    }
  }

  if ('allowedHosts' in update) {
    const h = update['allowedHosts'];
    if (!Array.isArray(h) || !(h as unknown[]).every(v => typeof v === 'string')) {
      sendJson(res, 400, { error: { message: '"allowedHosts" must be an array of strings', code: 400 } });
      return;
    }
  }

  if ('secretEnvKey' in update) {
    if (typeof update['secretEnvKey'] !== 'string' || (update['secretEnvKey'] as string).trim() === '') {
      sendJson(res, 400, { error: { message: '"secretEnvKey" must be a non-empty string', code: 400 } });
      return;
    }
  }

  const allowedKeys = new Set(['enabled', 'port', 'allowedHosts', 'secretEnvKey']);
  const unknownKeys = Object.keys(update).filter(k => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    sendJson(res, 400, { error: { message: `Unknown gateway fields: ${unknownKeys.join(', ')}`, code: 400 } });
    return;
  }

  try {
    const config = readConfig();
    const existing = (config['gateway'] ?? {}) as Record<string, unknown>;
    config['gateway'] = { ...existing, ...update };
    writeConfig(config);
    log.info({ keys: Object.keys(update) }, 'Settings gateway updated');
    sendJson(res, 200, { status: 'ok', data: config['gateway'] });
  } catch (err) {
    log.error({ err }, 'PUT settings/gateway failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});

// --- GET /api/admin/settings/personas ---------------------------------------

adminRouter.get('/api/admin/settings/personas', async (_req, res) => {
  log.debug('GET /api/admin/settings/personas');
  try {
    const config = readConfig();
    const meta = (config['meta'] ?? {}) as Record<string, unknown>;
    const activePersona = (meta['persona'] as string | undefined) ?? 'assistant';
    sendJson(res, 200, {
      status: 'ok',
      data: {
        personas: PERSONAS,
        active: activePersona,
      },
    });
  } catch (err) {
    log.error({ err }, 'GET settings/personas failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});

// --- PUT /api/admin/settings/persona ----------------------------------------

adminRouter.put('/api/admin/settings/persona', async (req, res) => {
  log.debug('PUT /api/admin/settings/persona');

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: (err as Error).message, code: 400 } });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: 'Request body must be a JSON object', code: 400 } });
    return;
  }

  const update = body as Record<string, unknown>;
  const personaId = update['id'];

  if (!personaId || typeof personaId !== 'string' || personaId.trim() === '') {
    sendJson(res, 400, { error: { message: 'Body must contain a non-empty string field "id"', code: 400 } });
    return;
  }

  if (!PERSONA_IDS.has(personaId.trim())) {
    sendJson(res, 400, {
      error: {
        message: `Unknown persona "${personaId}". Valid values: ${[...PERSONA_IDS].join(', ')}`,
        code: 400,
      },
    });
    return;
  }

  const chosen = personaId.trim();

  try {
    const config = readConfig();
    const meta = (config['meta'] ?? {}) as Record<string, unknown>;
    meta['persona'] = chosen;
    config['meta'] = meta;
    writeConfig(config);
    const personaMeta = PERSONAS.find(p => p.id === chosen);
    log.info({ persona: chosen }, 'Active persona updated');
    sendJson(res, 200, { status: 'ok', data: { active: chosen, persona: personaMeta } });
  } catch (err) {
    log.error({ err }, 'PUT settings/persona failed');
    sendJson(res, 500, { error: { message: (err as Error).message, code: 500 } });
  }
});
