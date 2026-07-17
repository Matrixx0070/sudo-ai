/**
 * @file update.ts
 * @description CLI command handler for `sudo-ai update`.
 *
 * Provides: --check, --rollback, --status flags for update management.
 * Instantiates an AutoUpdateManager in one-shot mode (no periodic timer).
 */

import path from 'node:path';
import { AutoUpdateManager } from '../../core/update/update-manager.js';
import { DEFAULT_UPDATE_CONFIG, readUpdateEnvOverrides } from '../../core/update/update-manager-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpdateOptions {
  check?: boolean;
  channel?: string;
  rollback?: boolean;
  status?: boolean;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function runUpdate(projectRoot: string, opts: UpdateOptions): Promise<number> {
  const config = {
    ...DEFAULT_UPDATE_CONFIG,
    ...readUpdateEnvOverrides(),
    projectRoot,
    // Explicit CLI flag beats env.
    ...(opts.channel ? { channel: opts.channel as 'latest' | 'stable' } : {}),
  };

  const manager = new AutoUpdateManager({ config });

  try {
    // Status: show current version and history
    if (opts.status) {
      const status = manager.getStatus();
      console.log(`Current version: ${status.currentVersion}`);
      console.log(`Current git SHA:  ${status.currentGitSha}`);
      console.log(`\nVersion history:`);
      for (const v of status.versions) {
        const marker = v.isActive ? ' ← active' : '';
        console.log(`  ${v.version} (${v.gitSha.substring(0, 8)}) [${v.channel}] ${v.installedAt}${marker}`);
      }
      return 0;
    }

    // Rollback: revert to previous version
    if (opts.rollback) {
      console.log('Rolling back to previous version...');
      const result = await manager.rollback();
      if (result.success) {
        console.log(`✓ Rolled back from ${result.fromVersion} to ${result.toVersion}`);
        return 0;
      }
      console.error(`✗ Rollback failed: ${result.error}`);
      return 1;
    }

    // Check: only check for updates, don't apply
    if (opts.check) {
      const result = await manager.checkNow(opts.channel as 'latest' | 'stable' | undefined);
      if (result.available) {
        console.log(`Update available: ${result.currentVersion} → ${result.newVersion} (${result.channel})`);
      } else {
        console.log(`No update available (${result.reason})`);
      }
      return 0;
    }

    // Default: check and apply
    const result = await manager.applyUpdate(opts.channel as 'latest' | 'stable' | undefined);
    if (result.success) {
      console.log(`✓ Updated from ${result.fromVersion} to ${result.toVersion}`);
      return 0;
    }
    console.error(`✗ Update failed at ${result.stage}: ${result.error}`);
    return 1;
  } finally {
    manager.close();
  }
}