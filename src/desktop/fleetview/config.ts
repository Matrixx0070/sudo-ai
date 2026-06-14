/**
 * @file src/desktop/fleetview/config.ts
 * @description Env config reader for the FleetView desktop wrapper (gap #25 slice 4).
 *
 * Pure utility, no Electron imports — the entry script validates env BEFORE
 * spawning Electron so misconfig fails honestly on stderr instead of crashing
 * inside the renderer process where the error has nowhere to go. Kept symmetric
 * with the TUI (slice 2) and JSON-RPC gateway (slice 3) env readers: same token
 * fallback chain, same host/port defaults, same discriminated-union result.
 */

/** Effective desktop runtime config. */
export interface DesktopConfig {
  /** Dashboard host. Default 127.0.0.1. */
  host: string;
  /** Dashboard port. Default 18910. */
  port: number;
  /** Bearer token. Required — injected into requests at the network layer. */
  token: string;
  /** BrowserWindow width in CSS pixels. Default 1100, min 400. */
  width: number;
  /** BrowserWindow height in CSS pixels. Default 750, min 300. */
  height: number;
}

export type ConfigResult =
  | { ok: true; config: DesktopConfig }
  | { ok: false; error: string };

/**
 * Read desktop config from env. Returns a discriminated union — never throws —
 * so the launcher can print a one-line error and exit before any Electron
 * processes get spawned (which would otherwise leak a child).
 *
 *   SUDO_DASHBOARD_HOST          (default 127.0.0.1)
 *   SUDO_DASHBOARD_PORT          (default 18910)
 *   SUDO_DASHBOARD_TOKEN         (required; falls back to GATEWAY_TOKEN)
 *   SUDO_DESKTOP_WIDTH           (default 1100, min 400)
 *   SUDO_DESKTOP_HEIGHT          (default 750, min 300)
 */
export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const token = (env['SUDO_DASHBOARD_TOKEN'] ?? env['GATEWAY_TOKEN'] ?? '').trim();
  if (token === '') {
    return {
      ok: false,
      error:
        'SUDO_DASHBOARD_TOKEN (or GATEWAY_TOKEN) is required. ' +
        'The desktop window proxies the existing dashboard server; both processes must share this token.',
    };
  }

  const host = (env['SUDO_DASHBOARD_HOST'] ?? '127.0.0.1').trim() || '127.0.0.1';
  const portRaw = env['SUDO_DASHBOARD_PORT'];
  const port = portRaw ? parseInt(portRaw, 10) : 18910;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, error: `SUDO_DASHBOARD_PORT "${portRaw}" is invalid` };
  }

  const widthRaw = env['SUDO_DESKTOP_WIDTH'];
  const widthParsed = widthRaw ? parseInt(widthRaw, 10) : 1100;
  const width = Number.isFinite(widthParsed) && widthParsed >= 400 ? widthParsed : 1100;

  const heightRaw = env['SUDO_DESKTOP_HEIGHT'];
  const heightParsed = heightRaw ? parseInt(heightRaw, 10) : 750;
  const height = Number.isFinite(heightParsed) && heightParsed >= 300 ? heightParsed : 750;

  return { ok: true, config: { host, port, token, width, height } };
}

/**
 * Build the dashboard URL the BrowserWindow should load.
 *
 * The dashboard server serves its embedded HTML at `/` (no auth — slice 1
 * decision: HTML is public, the API behind it is Bearer-gated). The HTML's
 * JS then calls `/api/*` with an Authorization header it pulls from
 * localStorage. The desktop wrapper substitutes for that storage path by
 * injecting the Bearer at the network layer (see main.cjs).
 *
 * Returned as a URL string the Electron loader expects.
 */
export function buildDashboardUrl(config: Pick<DesktopConfig, 'host' | 'port'>): string {
  return `http://${config.host}:${config.port}/`;
}

/**
 * Decide whether a navigation target is the dashboard origin we trust.
 *
 * Electron's `will-navigate` handler uses this to refuse anything off-origin
 * — clicking an external link should NOT replace the FleetView UI with an
 * arbitrary page inside the same window. Returns false on malformed input
 * (URL parse error), which the caller treats as "block".
 */
export function isAllowedDashboardOrigin(
  url: string,
  config: Pick<DesktopConfig, 'host' | 'port'>,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname !== config.host) return false;
  const parsedPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
  return parsedPort === config.port;
}
