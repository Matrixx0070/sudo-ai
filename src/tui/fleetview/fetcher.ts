/**
 * @file src/tui/fleetview/fetcher.ts
 * @description FleetView TUI HTTP fetcher (gap #25 slice 2).
 *
 * Talks to the same Bearer-authenticated dashboard server (gap #25 slice 1)
 * the embedded HTML UI polls. Kept tiny and pure so the unit tests can spin up
 * a tiny http.Server and exercise the full request/response path without
 * touching ink.
 */

import { request as httpRequest } from 'node:http';
import type { LiveAgentsData } from '../../core/dashboard/dashboard-types.js';

/** Effective TUI runtime config. */
export interface TuiConfig {
  /** Dashboard host. Default 127.0.0.1. */
  host: string;
  /** Dashboard port. Default 18910. */
  port: number;
  /** Bearer token. Required — the server returns 401 without it. */
  token: string;
  /** Poll interval in ms. Minimum 250 (avoid hammering the server). Default 1500. */
  pollMs: number;
  /** Per-request timeout in ms. Default 4000. */
  requestTimeoutMs: number;
}

/**
 * Read TUI config from env vars. Returns a `{ ok: true, config }` shape on
 * success and `{ ok: false, error }` on missing-token so the entry script can
 * fail honestly without throwing across the JSX/ink boundary.
 *
 *   SUDO_DASHBOARD_HOST            (default 127.0.0.1)
 *   SUDO_DASHBOARD_PORT            (default 18910)
 *   SUDO_DASHBOARD_TOKEN           (required — Bearer token)
 *   SUDO_TUI_POLL_MS               (default 1500, min 250)
 *   SUDO_TUI_REQUEST_TIMEOUT_MS    (default 4000, min 500)
 */
export type ConfigResult =
  | { ok: true; config: TuiConfig }
  | { ok: false; error: string };

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const token = (env['SUDO_DASHBOARD_TOKEN'] ?? env['GATEWAY_TOKEN'] ?? '').trim();
  if (token === '') {
    return {
      ok: false,
      error:
        'SUDO_DASHBOARD_TOKEN (or GATEWAY_TOKEN) is required. ' +
        'The dashboard server prints this on boot when no token is pinned, ' +
        'or set it explicitly to share across processes.',
    };
  }

  const host = (env['SUDO_DASHBOARD_HOST'] ?? '127.0.0.1').trim() || '127.0.0.1';
  const portRaw = env['SUDO_DASHBOARD_PORT'];
  const port = portRaw ? parseInt(portRaw, 10) : 18910;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, error: `SUDO_DASHBOARD_PORT "${portRaw}" is invalid` };
  }

  const pollRaw = env['SUDO_TUI_POLL_MS'];
  const pollParsed = pollRaw ? parseInt(pollRaw, 10) : 1500;
  const pollMs = Number.isFinite(pollParsed) && pollParsed >= 250 ? pollParsed : 1500;

  const timeoutRaw = env['SUDO_TUI_REQUEST_TIMEOUT_MS'];
  const timeoutParsed = timeoutRaw ? parseInt(timeoutRaw, 10) : 4000;
  const requestTimeoutMs =
    Number.isFinite(timeoutParsed) && timeoutParsed >= 500 ? timeoutParsed : 4000;

  return { ok: true, config: { host, port, token, pollMs, requestTimeoutMs } };
}

/** Result of a single fetch attempt. */
export type FetchResult =
  | { ok: true; data: LiveAgentsData }
  | { ok: false; error: string };

/**
 * Fetch a single FleetView snapshot from the dashboard server.
 *
 * Uses the built-in http module rather than fetch() so it works on every Node
 * 22+ runtime without the global-fetch / undici quirks. Returns honest result
 * shapes — never throws across the JSX boundary.
 */
export function fetchLiveAgents(config: TuiConfig): Promise<FetchResult> {
  return new Promise((resolve) => {
    // settled guards against the timeout-then-error sequence: when the
    // timeout fires we destroy the request which immediately emits 'error'
    // with ECONNRESET; without this flag the error handler would resolve a
    // second time (Promise resolves are idempotent so behavior is safe, but
    // the error message would race the timeout message — verifier HIGH 1).
    let settled = false;
    const settle = (result: FetchResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = httpRequest(
      {
        host: config.host,
        port: config.port,
        path: '/api/agents/live',
        method: 'GET',
        headers: { Authorization: `Bearer ${config.token}` },
        timeout: config.requestTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 401) {
            settle({ ok: false, error: 'Unauthorized — check SUDO_DASHBOARD_TOKEN' });
            return;
          }
          if ((res.statusCode ?? 0) >= 400) {
            settle({
              ok: false,
              error: `HTTP ${res.statusCode}: ${body.slice(0, 200)}`,
            });
            return;
          }
          try {
            const parsed = JSON.parse(body) as LiveAgentsData;
            // Minimal shape check — the server controls the schema, but a
            // future-version drift shouldn't crash the TUI. The renderer
            // guards against per-agent field gaps (shortId/formatElapsed
            // both fail safely on null/undefined input), so we accept any
            // spawned-array entry rather than rejecting otherwise-useful
            // responses on a single bad entry.
            if (
              parsed &&
              Array.isArray(parsed.spawned) &&
              typeof parsed.slotsUsed === 'number' &&
              typeof parsed.slotsMax === 'number' &&
              typeof parsed.queueWaiting === 'number'
            ) {
              settle({ ok: true, data: parsed });
              return;
            }
            settle({ ok: false, error: 'malformed FleetView response' });
          } catch (err) {
            settle({
              ok: false,
              error: `parse error: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        });
      },
    );
    req.on('error', (err) => {
      settle({
        ok: false,
        error: `connection error: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
    req.on('timeout', () => {
      settle({ ok: false, error: `request timed out after ${config.requestTimeoutMs}ms` });
      req.destroy();
    });
    req.end();
  });
}
