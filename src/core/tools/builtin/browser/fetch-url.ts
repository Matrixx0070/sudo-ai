/**
 * browser.fetch — Fetch the text content of any URL via HTTP GET.
 *
 * Uses native Node.js fetch() with AbortSignal timeout. No browser or
 * Playwright required. Best for APIs, raw HTML pages, JSON endpoints,
 * plain-text resources, and anything that does not require JavaScript
 * rendering.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { toolFetch } from '../../../security/guarded-fetch.js';
import { evaluateJsonQuery } from './json-query.js';

const logger = createLogger('browser.fetch');

// Kept under the agent loop's 24K tool-output clamp so the fetch's own
// truncation warning survives to the model. 8K was far too small for data
// endpoints — a newest-first list truncated at 8K silently dropped the very
// entries a "find the latest X" query needs, and the model then confabulated
// a plausible value instead of reporting the response was incomplete.
const DEFAULT_MAX_LENGTH = 20_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Truncate a fetched body to `maxLength`, with a loud, instructive warning at
 * the TOP (so it survives any downstream head-clamp) plus a tail marker. An
 * incomplete response must not be answered from as if it were complete —
 * entries past the cutoff are unseen, not absent. Exported for tests.
 */
export function applyFetchTruncation(rawText: string, maxLength: number): string {
  if (rawText.length <= maxLength) return rawText;
  const omitted = rawText.length - maxLength;
  return (
    `⚠️ TRUNCATED RESPONSE — showing the first ${maxLength} of ${rawText.length} characters ` +
    `(${omitted} omitted). The content below is INCOMPLETE: entries past the cutoff are NOT shown — ` +
    `do NOT treat them as missing or answer "latest/newest/last" from this partial data. ` +
    `Re-fetch with a larger maxLength or a more specific URL/endpoint first.\n\n` +
    rawText.slice(0, maxLength) +
    `\n\n...[truncated — ${rawText.length} total chars, ${omitted} omitted; response is INCOMPLETE]`
  );
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const fetchUrlTool: ToolDefinition = {
  name: 'browser.fetch',
  description:
    'Fetch the content of a URL and return as text. Simple HTTP GET — no browser needed. ' +
    'Good for APIs, raw pages, JSON endpoints. Does not execute JavaScript. For a large ' +
    'JSON response, pass jsonQuery to extract just what you need server-side instead of ' +
    'reasoning over a truncated blob — e.g. jsonQuery="select(.lts) | first | .version".',
  category: 'browser',
  timeout: DEFAULT_TIMEOUT_MS + 2_000,
  parameters: {
    url: {
      type: 'string',
      required: true,
      description: 'URL to fetch (http or https).',
    },
    maxLength: {
      type: 'number',
      required: false,
      description: `Maximum characters to return (default: ${DEFAULT_MAX_LENGTH}).`,
    },
    jsonQuery: {
      type: 'string',
      required: false,
      description:
        'Optional jq-style query applied to a JSON response, returning only the extracted ' +
        'result (avoids truncation). Pipe stages: path (.a.b[0]), select(.k) / select(.k == "v"), ' +
        'map(.k), first, last, length, keys. Example: "select(.lts) | first | .version".',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // --- Input validation ---------------------------------------------------
    const rawUrl = params['url'];
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      return { success: false, output: 'browser.fetch: "url" parameter is required.', data: {} };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl.trim());
    } catch {
      return { success: false, output: `browser.fetch: invalid URL "${rawUrl}".`, data: {} };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        success: false,
        output: `browser.fetch: only http/https URLs are supported (got ${parsedUrl.protocol}).`,
        data: {},
      };
    }

    const maxLength =
      typeof params['maxLength'] === 'number' && params['maxLength'] > 0
        ? Math.floor(params['maxLength'])
        : DEFAULT_MAX_LENGTH;

    const timeoutMs = DEFAULT_TIMEOUT_MS;

    logger.info({ session: ctx.sessionId, url: parsedUrl.href, maxLength }, 'Fetching URL');

    // --- Fetch with timeout -------------------------------------------------
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Also honour upstream abort signal
    const onUpstreamAbort = (): void => controller.abort();
    if (ctx.signal) {
      ctx.signal.addEventListener('abort', onUpstreamAbort, { once: true });
    }

    try {
      const response = await toolFetch(parsedUrl.href, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SUDO-AI/4.0)',
          'Accept': 'text/html,application/json,text/plain,*/*',
        },
        redirect: 'follow',
      });

      const contentType = response.headers.get('content-type') ?? 'unknown';
      const status = response.status;

      if (!response.ok) {
        logger.warn({ session: ctx.sessionId, url: parsedUrl.href, status }, 'Non-OK HTTP response');
      }

      const rawText = await response.text();

      // Structured extraction: when a jsonQuery is supplied and the body parses
      // as JSON, return ONLY the queried result — small, exact, un-truncated —
      // so the model never reasons over a giant blob.
      const jsonQuery = typeof params['jsonQuery'] === 'string' ? (params['jsonQuery'] as string).trim() : '';
      if (jsonQuery && response.ok) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          return {
            success: false,
            output: `browser.fetch: jsonQuery was given but the response from ${parsedUrl.href} is not valid JSON (${rawText.length} chars). Omit jsonQuery to get the raw text.`,
            data: { status, contentType, length: rawText.length, jsonQuery },
          };
        }
        try {
          const result = evaluateJsonQuery(parsed, jsonQuery);
          const out = JSON.stringify(result, null, 2);
          logger.info({ session: ctx.sessionId, url: parsedUrl.href, status, jsonQuery, resultLen: out.length }, 'URL fetched + jsonQuery applied');
          return {
            success: true,
            output: applyFetchTruncation(out, maxLength),
            data: { status, contentType, length: rawText.length, jsonQuery, queried: true },
          };
        } catch (qErr) {
          const msg = qErr instanceof Error ? qErr.message : String(qErr);
          return {
            success: false,
            output: `browser.fetch: jsonQuery "${jsonQuery}" failed — ${msg}. The response WAS valid JSON (${rawText.length} chars); fix the query or omit it for raw text.`,
            data: { status, contentType, length: rawText.length, jsonQuery },
          };
        }
      }

      const truncated = rawText.length > maxLength;
      const text = applyFetchTruncation(rawText, maxLength);

      logger.info(
        { session: ctx.sessionId, url: parsedUrl.href, status, length: rawText.length, truncated },
        'URL fetched successfully',
      );

      return {
        success: response.ok,
        output: response.ok
          ? text
          : `HTTP ${status} from ${parsedUrl.href}:\n${text}`,
        data: {
          status,
          contentType,
          length: rawText.length,
          truncated,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ session: ctx.sessionId, url: parsedUrl.href, err }, 'Fetch failed');
      return {
        success: false,
        output: `browser.fetch error: ${msg}`,
        data: { status: 0, contentType: 'unknown', length: 0, truncated: false },
      };
    } finally {
      clearTimeout(timer);
      if (ctx.signal) {
        ctx.signal.removeEventListener('abort', onUpstreamAbort);
      }
    }
  },
};
