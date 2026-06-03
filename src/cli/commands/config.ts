/**
 * @file cli/commands/config.ts
 * @description Config sub-command for the SUDO-AI CLI.
 *
 * Supports:
 *   --validate   Load and validate config/sudo-ai.json5; exit 0 on success, 1 on failure.
 *   --path       Print the resolved absolute path to the config file.
 *
 * Wave2 polish: added runConfigWizard entrypoint (for `sudo-ai setup` / ongoing TUI).
 * Full 100x Ink wizard (cross/P1 enable, xai-auth, profiles, kills, SOUL, service, learner/KAIROS) lives in setup.ts (imported by setup cmd + future index hook).
 * Use `sudo-ai setup` (or `sudo-ai config --setup` once wired) for first/ongoing.
 */

import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the SUDO-AI configuration file.
 *
 * Dynamically loads ConfigLoader to perform a full parse + schema validation.
 * Prints a human-readable result and returns the appropriate exit code.
 *
 * @param projectRoot Absolute path to the project root.
 * @returns 0 on success, 1 on any validation failure.
 */
export async function runConfigValidate(projectRoot: string): Promise<number> {
  const configFilePath = path.resolve(projectRoot, 'config', 'sudo-ai.json5');

  if (!fs.existsSync(configFilePath)) {
    console.error(`[config] Config file not found: ${configFilePath}`);
    return 1;
  }

  try {
    const { ConfigLoader } = await import('../../core/config/loader.js');
    const loader = new ConfigLoader(projectRoot);
    await loader.load();
    const cfg = loader.get();
    console.log(`[config] Valid — loaded as "${cfg.meta.name}" (tz: ${cfg.meta.timezone})`);
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[config] Validation failed: ${msg}`);
    return 1;
  }
}

/**
 * Print the resolved absolute path to the SUDO-AI config file.
 *
 * @param projectRoot Absolute path to the project root.
 */
export function runConfigPath(projectRoot: string): void {
  const configFilePath = path.resolve(projectRoot, 'config', 'sudo-ai.json5');
  console.log(configFilePath);
}

/**
 * Wave2: Launch the full Ink TUI setup wizard (first-time + ongoing 100x).
 * Delegates to setup.ts (new setup* file in boundaries). Used by `sudo-ai setup` cmd
 * (and can be wired for auto first-run hook in cli/index.ts post this wave).
 * Returns 0 on success.
 */
export async function runConfigWizard(projectRoot: string): Promise<number> {
  try {
    const { runSetup } = await import('./setup.js');
    await runSetup(projectRoot, {});
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[config] wizard failed: ${msg}`);
    return 1;
  }
}
