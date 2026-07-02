/**
 * comms.webhook — Send HTTP webhooks and maintain an in-memory registry
 * of named endpoints.
 *
 * Operations:
 *   send     — POST (or custom method) a JSON payload to a URL
 *   register — Save a named endpoint URL for later reuse
 *   list     — List all registered endpoint names and their URLs
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { toolFetch } from '../../../security/guarded-fetch.js';

const log = createLogger('comms:webhook');

// ---------------------------------------------------------------------------
// In-memory endpoint registry (process-lifetime)
// ---------------------------------------------------------------------------

interface WebhookEndpoint {
  name: string;
  url: string;
  registeredAt: string;
}

const endpointRegistry = new Map<string, WebhookEndpoint>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

async function sendWebhook(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  method: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  const isBodyMethod = method !== 'GET' && method !== 'DELETE';

  const res = await toolFetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(isBodyMethod ? { body: JSON.stringify(payload) } : {}),
    signal,
  });

  let body: string;
  try {
    body = await res.text();
  } catch {
    body = '';
  }

  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const webhookTool: ToolDefinition = {
  name: 'comms.webhook',
  description:
    'Send HTTP webhooks or manage a named endpoint registry. ' +
    'Operations: send (HTTP request to a URL with JSON payload), ' +
    'register (save a named endpoint), list (show registered endpoints).',
  category: 'comms',
  timeout: 30_000,
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: ['send', 'register', 'list'],
      description: 'Webhook operation to perform.',
    },
    url: {
      type: 'string',
      required: false,
      description: 'Target URL. Required for "send" and "register".',
    },
    payload: {
      type: 'object',
      required: false,
      description: 'JSON payload to send. Used in "send" operation.',
      properties: {},
    },
    headers: {
      type: 'object',
      required: false,
      description: 'Optional HTTP headers as key-value pairs.',
      properties: {},
    },
    method: {
      type: 'string',
      required: false,
      default: 'POST',
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      description: 'HTTP method for "send". Defaults to POST.',
    },
    name: {
      type: 'string',
      required: false,
      description: 'Endpoint name for "register" operation.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = typeof params['operation'] === 'string' ? params['operation'] : '';

    if (!['send', 'register', 'list'].includes(operation)) {
      return {
        success: false,
        output: 'comms.webhook: "operation" must be one of: send, register, list.',
      };
    }

    // ------------------------------------------------------------------
    // list
    // ------------------------------------------------------------------
    if (operation === 'list') {
      const endpoints = [...endpointRegistry.values()];
      log.info({ sessionId: ctx.sessionId, count: endpoints.length }, 'Webhook endpoints listed');
      return {
        success: true,
        output:
          endpoints.length === 0
            ? 'No webhook endpoints registered.'
            : `${endpoints.length} endpoint(s) registered:\n` +
              endpoints.map((e) => `  ${e.name} -> ${e.url}`).join('\n'),
        data: { endpoints },
      };
    }

    const rawUrl = typeof params['url'] === 'string' ? params['url'].trim() : '';

    if (!rawUrl) {
      return { success: false, output: `comms.webhook: "url" is required for "${operation}".` };
    }
    if (!isValidUrl(rawUrl)) {
      return {
        success: false,
        output: `comms.webhook: Invalid URL "${rawUrl}". Must be http or https.`,
      };
    }

    // ------------------------------------------------------------------
    // register
    // ------------------------------------------------------------------
    if (operation === 'register') {
      const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
      if (!name) {
        return { success: false, output: 'comms.webhook: "name" is required for "register".' };
      }

      const endpoint: WebhookEndpoint = {
        name,
        url: rawUrl,
        registeredAt: new Date().toISOString(),
      };
      endpointRegistry.set(name, endpoint);

      log.info({ sessionId: ctx.sessionId, name, url: rawUrl }, 'Webhook endpoint registered');
      return {
        success: true,
        output: `Webhook endpoint "${name}" registered at ${rawUrl}.`,
        data: endpoint,
      };
    }

    // ------------------------------------------------------------------
    // send
    // ------------------------------------------------------------------
    const payload = typeof params['payload'] === 'object' && params['payload'] !== null
      ? params['payload']
      : {};

    const rawHeaders =
      typeof params['headers'] === 'object' && params['headers'] !== null
        ? (params['headers'] as Record<string, unknown>)
        : {};
    const headers: Record<string, string> = Object.fromEntries(
      Object.entries(rawHeaders)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => [k, v as string]),
    );

    const rawMethod = typeof params['method'] === 'string'
      ? params['method'].toUpperCase()
      : 'POST';
    const method = ALLOWED_METHODS.has(rawMethod) ? rawMethod : 'POST';

    try {
      const { status, body } = await sendWebhook(rawUrl, payload, headers, method, ctx.signal);

      const success = status >= 200 && status < 300;
      log.info(
        { sessionId: ctx.sessionId, url: rawUrl, method, status, success },
        'Webhook sent',
      );

      return {
        success,
        output: success
          ? `Webhook ${method} ${rawUrl} -> HTTP ${status}`
          : `Webhook ${method} ${rawUrl} failed with HTTP ${status}: ${body.slice(0, 200)}`,
        data: { url: rawUrl, method, status, body: body.slice(0, 1000) },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId: ctx.sessionId, url: rawUrl, method, err }, 'Webhook send failed');
      return { success: false, output: `comms.webhook error: ${msg}` };
    }
  },
};

export default webhookTool;
