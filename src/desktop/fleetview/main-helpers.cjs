/**
 * @file src/desktop/fleetview/main-helpers.cjs
 * @description Pure helpers extracted from main.cjs so they're require-able
 * without triggering Electron's app.whenReady side effects (gap #25 slice 4).
 *
 * Mirrors the TypeScript helpers in config.ts. We duplicate the logic
 * deliberately: config.ts ships as ESM via tsx (used by the launcher), this
 * file ships as CommonJS for the Electron main process. Keeping a colocated
 * unit test for this CJS copy closes verifier LOW #3 (untested duplicate).
 */

'use strict';

function readEnvConfig(env) {
  const e = env || process.env;
  const token = (e.SUDO_DASHBOARD_TOKEN || e.GATEWAY_TOKEN || '').trim();
  if (token === '') return null;
  const host = (e.SUDO_DASHBOARD_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const portRaw = e.SUDO_DASHBOARD_PORT;
  const port = portRaw ? parseInt(portRaw, 10) : 18910;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  const widthRaw = e.SUDO_DESKTOP_WIDTH;
  const widthParsed = widthRaw ? parseInt(widthRaw, 10) : 1100;
  const width = Number.isFinite(widthParsed) && widthParsed >= 400 ? widthParsed : 1100;
  const heightRaw = e.SUDO_DESKTOP_HEIGHT;
  const heightParsed = heightRaw ? parseInt(heightRaw, 10) : 750;
  const height = Number.isFinite(heightParsed) && heightParsed >= 300 ? heightParsed : 750;
  return { host, port, token, width, height };
}

function isAllowedOrigin(url, cfg) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname !== cfg.host) return false;
  const parsedPort = parsed.port
    ? parseInt(parsed.port, 10)
    : (parsed.protocol === 'https:' ? 443 : 80);
  return parsedPort === cfg.port;
}

module.exports = { readEnvConfig, isAllowedOrigin };
