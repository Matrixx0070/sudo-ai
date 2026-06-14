/**
 * @file src/gateway/jsonrpc/fetcher.ts
 * @description Generic Bearer-authenticated dashboard fetcher for the JSON-RPC
 * gateway (gap #25 slice 3).
 *
 * The gateway proxies requests over the existing dashboard HTTP server: each
 * gateway method maps to one GET on `/api/...`. Kept tiny and pure so methods
 * can be unit-tested against a stub http.Server without dragging the JSON-RPC
 * connection in. Same Bearer-token resolution chain (`SUDO_DASHBOARD_TOKEN ??
 * GATEWAY_TOKEN`) the TUI uses.
 */

import { request as httpRequest } from 'node:http';

/** Effective gateway runtime config. */
export interface GatewayConfig {
  host: string;
  port: number;
  token: string;
  requestTimeoutMs: number;
}

/**
 * Read config from env. Returns a discriminated union — never throws — so the
 * entry script can fail honestly without the JSON-RPC connection being half
 * up.
 *
 *   SUDO_DASHBOARD_HOST            (default 127.0.0.1)
 *   SUDO_DASHBOARD_PORT            (default 18910)
 *   SUDO_DASHBOARD_TOKEN           (required — Bearer token; falls back to GATEWAY_TOKEN)
 *   SUDO_GATEWAY_REQUEST_TIMEOUT_MS (default 4000, min 500)
 */
export type ConfigResult =
  | { ok: true; config: GatewayConfig }
  | { ok: false; error: string };

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const token = (env['SUDO_DASHBOARD_TOKEN'] ?? env['GATEWAY_TOKEN'] ?? '').trim();
  if (token === '') {
    return {
      ok: false,
      error:
        'SUDO_DASHBOARD_TOKEN (or GATEWAY_TOKEN) is required. ' +
        'The gateway proxies the existing dashboard server; both processes must share this token.',
    };
  }

  const host = (env['SUDO_DASHBOARD_HOST'] ?? '127.0.0.1').trim() || '127.0.0.1';
  const portRaw = env['SUDO_DASHBOARD_PORT'];
  const port = portRaw ? parseInt(portRaw, 10) : 18910;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, error: `SUDO_DASHBOARD_PORT "${portRaw}" is invalid` };
  }

  const timeoutRaw = env['SUDO_GATEWAY_REQUEST_TIMEOUT_MS'];
  const timeoutParsed = timeoutRaw ? parseInt(timeoutRaw, 10) : 4000;
  const requestTimeoutMs =
    Number.isFinite(timeoutParsed) && timeoutParsed >= 500 ? timeoutParsed : 4000;

  return { ok: true, config: { host, port, token, requestTimeoutMs } };
}

/** Result of a single GET attempt — string-keyed for the methods to narrow. */
export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

/**
 * Perform one Bearer-authenticated GET against the dashboard server. Each
 * gateway method calls this once; the method maps the FetchResult to either a
 * JSON-RPC result or an AcpRpcError.
 *
 * The `parser` lets a method bind the response type at compile time without
 * runtime-enforcing structural checks per-method (kept fully generic).
 */
export function dashboardGet<T>(
  config: GatewayConfig,
  path: string,
  parser: (body: string) => T = (s) => JSON.parse(s) as T,
): Promise<FetchResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: FetchResult<T>): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const req = httpRequest(
      {
        host: config.host,
        port: config.port,
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${config.token}` },
        timeout: config.requestTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status === 401) {
            settle({ ok: false, error: 'Unauthorized — check SUDO_DASHBOARD_TOKEN', status });
            return;
          }
          if (status >= 400) {
            settle({ ok: false, error: `HTTP ${status}: ${body.slice(0, 200)}`, status });
            return;
          }
          try {
            const data = parser(body);
            settle({ ok: true, data });
          } catch (err) {
            settle({
              ok: false,
              error: `parse error: ${err instanceof Error ? err.message : String(err)}`,
              status,
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
