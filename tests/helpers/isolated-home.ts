/**
 * @file tests/helpers/isolated-home.ts
 * @description Give a test its own SUDO_AI_HOME so it cannot read live state.
 *
 * WHY (2026-08-06): five suites failed on a real machine while passing on CI,
 * every one for the same reason — they read PRODUCTION state:
 *
 *   - `system-prompt-inject-caps` read the live `workspace/MEMORY.md` (44,798
 *     bytes here, over the 10KB inject cap), so a truncation marker appeared
 *     and an assertion that no truncation happened failed.
 *   - `transport` deleted `XAI_API_KEY` from the env but `getProviderApiKey`
 *     falls back to the on-disk store `data/xai-apikey.json`, which exists here.
 *   - `gdrive/cli` and `health/cw6` read the live manifest / gateway state.
 *
 * CI's checkout has none of that, so the suite is green there and red on any
 * machine with real data. "CI is green" was therefore a weaker signal than it
 * looked, and the local suite could not be trusted at all.
 *
 * `SUDO_AI_HOME` is the single lever: `paths.ts` derives PROJECT_ROOT from it,
 * and both DATA_DIR and WORKSPACE_DIR hang off PROJECT_ROOT.
 *
 * CRUCIAL: `paths.ts` captures those at MODULE LOAD. Setting the env in
 * `beforeEach` is not enough if the module under test was imported statically
 * at the top of the file — it already resolved against the real root. Tests
 * using this helper must `await import(...)` the module under test INSIDE the
 * test body (the helper calls `vi.resetModules()` for exactly this reason).
 */

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, vi } from 'vitest';

export interface IsolatedHome {
  /** Absolute path to this test's private home. Valid inside a test body. */
  dir(): string;
  /** `<home>/data` — created for you. */
  dataDir(): string;
  /** `<home>/workspace` — created for you. */
  workspaceDir(): string;
}

/**
 * Register per-test isolation of SUDO_AI_HOME (and DATA_DIR, which some code
 * reads directly). Call at describe scope; it installs its own
 * beforeEach/afterEach and restores the previous environment.
 */
export function useIsolatedHome(prefix = 'sudo-iso-'): IsolatedHome {
  let home = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), prefix));
    mkdirSync(path.join(home, 'data'), { recursive: true });
    mkdirSync(path.join(home, 'workspace'), { recursive: true });
    for (const k of ['SUDO_AI_HOME', 'DATA_DIR']) saved[k] = process.env[k];
    process.env['SUDO_AI_HOME'] = home;
    process.env['DATA_DIR'] = path.join(home, 'data');
    // paths.ts captures PROJECT_ROOT/DATA_DIR/WORKSPACE_DIR at import time.
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ['SUDO_AI_HOME', 'DATA_DIR']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (home) rmSync(home, { recursive: true, force: true });
    home = '';
  });

  return {
    dir: () => home,
    dataDir: () => path.join(home, 'data'),
    workspaceDir: () => path.join(home, 'workspace'),
  };
}
