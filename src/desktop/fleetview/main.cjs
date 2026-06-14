/**
 * @file src/desktop/fleetview/main.cjs
 * @description Electron main process for the FleetView desktop wrapper (gap #25 slice 4).
 *
 * Runs inside the Electron runtime (NOT Node) — spawned by index.ts via the
 * `electron` CLI binary. Kept in plain CommonJS so no transpile/bundle step is
 * needed between checkout and `pnpm desktop:fleetview`.
 *
 * Responsibilities:
 *   1. Read env config (the launcher already validated it, but we live in a
 *      separate process so we re-read).
 *   2. Open a single BrowserWindow against the dashboard URL.
 *   3. Inject the Bearer token at the network layer via
 *      session.webRequest.onBeforeSendHeaders — bound to win.webContents.session
 *      (NOT session.defaultSession) so a future second-window scenario can't
 *      accidentally inherit the filter for unrelated sessions (verifier MED #2).
 *      Bound ONCE per window — also covers verifier LOW #1.
 *   4. Restrict in-window navigation AND server-side redirects to the dashboard
 *      origin. will-navigate covers user-initiated nav; will-redirect covers
 *      HTTP 3xx — a server-side redirect to evil.example would otherwise
 *      bypass will-navigate entirely (verifier HIGH #1).
 *   5. setWindowOpenHandler routes external clicks to shell.openExternal and
 *      denies same-origin window.open (single-window operator surface).
 *   6. Quit on all-windows-closed regardless of platform.
 */

'use strict';

const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');
const { readEnvConfig, isAllowedOrigin } = require('./main-helpers.cjs');

function bindBearerInjector(targetSession, cfg) {
  // Filtering by host:port ensures the Bearer cannot leak via an off-origin
  // redirect (any URL not matching the dashboard origin is excluded by the
  // filter and gets no Authorization header from us). The header is set via
  // Object.assign(..., { Authorization: ... }) so it REPLACES whatever
  // Authorization the renderer/page placed there — the sentinel
  // "desktop-wrapper-injected" never reaches the wire.
  const filter = {
    urls: [`http://${cfg.host}:${cfg.port}/*`, `https://${cfg.host}:${cfg.port}/*`],
  };
  targetSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = Object.assign({}, details.requestHeaders, {
      Authorization: `Bearer ${cfg.token}`,
    });
    callback({ requestHeaders: headers });
  });
}

function createWindow(cfg) {
  const win = new BrowserWindow({
    width: cfg.width,
    height: cfg.height,
    title: 'SUDO FleetView',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Devtools off by default — operator surface, not a debug surface.
      // SUDO_DESKTOP_DEVTOOLS=1 re-enables for local debugging.
      devTools: process.env.SUDO_DESKTOP_DEVTOOLS === '1',
    },
  });

  // Bind the Bearer injector to THIS window's session — instance-scoped, not
  // global. Today win.webContents.session === session.defaultSession, but
  // referencing the instance documents the intent: each window owns its own
  // filter, so a future multi-window or multi-session refactor doesn't leak
  // the token across unrelated sessions (verifier MED #2 + LOW #1).
  bindBearerInjector(win.webContents.session, cfg);

  // Refuse renderer-initiated nav away from the dashboard origin.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedOrigin(url, cfg)) {
      event.preventDefault();
    }
  });

  // Refuse server-side HTTP 3xx redirects pointing off-origin. will-navigate
  // does NOT fire for these — a dashboard server bug or a future proxy could
  // otherwise send the wrapper to an arbitrary URL inside the same window
  // (verifier HIGH #1).
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedOrigin(url, cfg)) {
      event.preventDefault();
    }
  });

  // External links open in the OS browser, never inside the wrapper window.
  // setWindowOpenHandler is the current Electron recommendation;
  // window.open() returns null in the renderer rather than spawning a popup.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url, cfg)) {
      // Same-origin window.open is still denied — operator tool, not a
      // tabbed browser.
      return { action: 'deny' };
    }
    void Promise.resolve(shell.openExternal(url)).catch(() => {
      // openExternal can fail on minimal Linux installs without xdg-open;
      // silent fail keeps the renderer responsive.
    });
    return { action: 'deny' };
  });

  void win.loadURL(`http://${cfg.host}:${cfg.port}/`);
  return win;
}

function main() {
  const cfg = readEnvConfig(process.env);
  if (cfg === null) {
    process.stderr.write(
      'desktop-fleetview: invalid env (SUDO_DASHBOARD_TOKEN/_PORT). ' +
        'Launcher should have caught this — please report.\n',
    );
    process.exit(1);
    return;
  }

  void app.whenReady().then(() => {
    createWindow(cfg);

    app.on('activate', () => {
      // macOS: re-create window on dock-click if all windows are closed but
      // the app is still running. We accept that this rebinds a NEW filter
      // on the new window's session; old window is gone so no listener
      // accumulation on a still-live session.
      if (BrowserWindow.getAllWindows().length === 0) createWindow(cfg);
    });
  });

  app.on('window-all-closed', () => {
    // Operator surface: quit on close regardless of platform. Standard macOS
    // dock-persist behavior would leave a confusing "running" agent.
    app.quit();
  });
}

main();
