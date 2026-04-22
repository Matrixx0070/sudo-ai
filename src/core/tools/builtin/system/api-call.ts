/**
 * @file api-call.ts
 * @description system.api-call — generic REST API connector using native fetch().
 *
 * Supports GET, POST, PUT, PATCH, DELETE with custom headers, JSON body,
 * per-request timeout, and graceful error handling.
 * Response body is truncated to 4 000 characters for LLM consumption.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const log = createLogger('system:api-call');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS  = 30_000;
const MAX_RESPONSE_CHARS  = 4_000;
const ALLOWED_METHODS     = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_METHODS        = new Set(['POST', 'PUT', 'PATCH']);

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

function normalizeMethod(raw: unknown): string {
  const m = typeof raw === 'string' ? raw.toUpperCase().trim() : 'GET';
  return ALLOWED_METHODS.has(m) ? m : 'GET';
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k, v as string]),
  );
}

function extractResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const apiCallTool: ToolDefinition = {
  name: 'system.api-call',
  description:
    'Make HTTP requests to any REST API. ' +
    'Supports GET, POST, PUT, PATCH, DELETE with custom headers, JSON body, and auth. ' +
    'Response body is returned truncated to 4 000 characters.',
  category: 'system',
  timeout: 60_000,
  parameters: {
    url: {
      type: 'string',
      required: true,
      description: 'Full URL to call (must be http or https).',
    },
    method: {
      type: 'string',
      required: false,
      default: 'GET',
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      description: 'HTTP method. Defaults to GET.',
    },
    headers: {
      type: 'object',
      required: false,
      description: 'Custom HTTP headers as string key-value pairs.',
      properties: {},
    },
    body: {
      type: 'string',
      required: false,
      description: 'Request body as a JSON string. Used for POST, PUT, PATCH.',
    },
    timeout: {
      type: 'number',
      required: false,
      default: DEFAULT_TIMEOUT_MS,
      description: `Request timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}.`,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // -----------------------------------------------------------------------
    // Input validation
    // -----------------------------------------------------------------------
    const url = typeof params['url'] === 'string' ? params['url'].trim() : '';
    if (!url) {
      return { success: false, output: 'system.api-call: "url" parameter is required.' };
    }
    if (!isValidUrl(url)) {
      return {
        success: false,
        output: `system.api-call: invalid or non-HTTP(S) URL "${url}".`,
      };
    }

    const method    = normalizeMethod(params['method']);
    const headers   = normalizeHeaders(params['headers']);
    const rawBody   = typeof params['body'] === 'string' ? params['body'] : undefined;
    const timeoutMs = typeof params['timeout'] === 'number' && params['timeout'] > 0
      ? params['timeout']
      : DEFAULT_TIMEOUT_MS;

    // -----------------------------------------------------------------------
    // Build fetch options
    // -----------------------------------------------------------------------
    const mergedHeaders: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      ...headers,
    };

    // Set Content-Type for body methods if not overridden by caller
    if (BODY_METHODS.has(method) && rawBody && !mergedHeaders['Content-Type']) {
      mergedHeaders['Content-Type'] = 'application/json';
    }

    // Validate JSON body if provided
    if (rawBody && BODY_METHODS.has(method)) {
      try {
        JSON.parse(rawBody);
      } catch {
        return {
          success: false,
          output: 'system.api-call: "body" is not valid JSON. Provide a valid JSON string.',
        };
      }
    }

    const fetchOptions: RequestInit = {
      method,
      headers: mergedHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (rawBody && BODY_METHODS.has(method)) {
      fetchOptions.body = rawBody;
    }

    log.info(
      { sessionId: ctx.sessionId, method, url, timeoutMs },
      'API call initiated',
    );

    // -----------------------------------------------------------------------
    // Execute request
    // -----------------------------------------------------------------------
    const startMs = Date.now();
    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.toLowerCase().includes('timeout') ||
                        msg.toLowerCase().includes('aborted');
      log.error({ sessionId: ctx.sessionId, url, method, err }, 'API call network error');
      return {
        success: false,
        output: isTimeout
          ? `system.api-call: request timed out after ${timeoutMs}ms for ${method} ${url}`
          : `system.api-call network error: ${msg}`,
      };
    }

    const durationMs = Date.now() - startMs;

    // -----------------------------------------------------------------------
    // Read body
    // -----------------------------------------------------------------------
    let rawText = '';
    try {
      rawText = await response.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ sessionId: ctx.sessionId, url, err }, 'Failed to read response body');
      rawText = `(failed to read body: ${msg})`;
    }

    const truncated = rawText.length > MAX_RESPONSE_CHARS;
    const bodyText  = truncated ? rawText.slice(0, MAX_RESPONSE_CHARS) + '\n...(truncated)' : rawText;
    const responseHeaders = extractResponseHeaders(response.headers);
    const success   = response.status >= 200 && response.status < 300;

    log.info(
      { sessionId: ctx.sessionId, url, method, status: response.status, durationMs, success },
      'API call complete',
    );

    return {
      success,
      output: success
        ? `${method} ${url} → HTTP ${response.status} (${durationMs}ms)\n\n${bodyText}`
        : `${method} ${url} failed with HTTP ${response.status} (${durationMs}ms)\n\n${bodyText}`,
      data: {
        status: response.status,
        headers: responseHeaders,
        bodyLength: rawText.length,
        truncated,
        durationMs,
      },
    };
  },
};

export default apiCallTool;
