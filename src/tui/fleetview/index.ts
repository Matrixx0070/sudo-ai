/**
 * @file src/tui/fleetview/index.ts
 * @description Entry point for the FleetView TUI (gap #25 slice 2).
 *
 * Reads env config via {@link readConfigFromEnv}, then mounts the ink App.
 * Fails honestly on missing/malformed env (exit 1 + helpful message) rather
 * than crashing inside JSX render.
 *
 * Invoke via `pnpm tui:fleetview` (uses tsx — no separate build step needed).
 * In production, run after `pnpm build` if you bundle the TUI yourself; the
 * default build target does NOT include this entry today (deferred to a
 * follow-up slice if/when packaging surfaces it as a binary).
 */

import { readConfigFromEnv } from './fetcher.js';

async function main(): Promise<void> {
  const cfgResult = readConfigFromEnv();
  if (!cfgResult.ok) {
    process.stderr.write(`fleetview-tui: ${cfgResult.error}\n`);
    process.exit(1);
  }

  // Defer the ink + JSX imports until after env validation so a misconfigured
  // run prints an honest error without dragging in the React runtime first.
  const { render } = await import('ink');
  const { App } = await import('./app.js');
  const React = await import('react');

  const { unmount, waitUntilExit } = render(
    React.createElement(App, { config: cfgResult.config }),
  );

  // Guard against double-unmount: useApp().exit() inside App fires when the
  // user presses q OR Ctrl+C; SIGINT/SIGTERM at the process level can also
  // fire (Ctrl+C delivers a SIGINT in parallel). Ink's unmount() happens to
  // be idempotent today but that's not a documented guarantee — pin it
  // here (verifier MED 1).
  let unmounted = false;
  const cleanup = (): void => {
    if (unmounted) return;
    unmounted = true;
    unmount();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await waitUntilExit();
}

void main();
