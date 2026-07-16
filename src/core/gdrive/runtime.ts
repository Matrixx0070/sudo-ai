/**
 * @file gdrive/runtime.ts
 * @description Lazy singleton runtime + cron entry points for the Drive layer.
 *
 * cli.ts wiring stays minimal: it registers the heartbeat CronJob and routes
 * the `gdrive:heartbeat` systemEvent here via dynamic import. Everything else
 * (config validation, client, bootstrap, audit) initializes lazily on first
 * job fire, and total failure is contained — the agent loop never depends on
 * anything in this module (prime directive 1/10).
 */

import { createLogger } from '../shared/logger.js';
import { AuditTrail } from '../security/audit-trail.js';
import { loadGdriveConfig, isGdriveEnabled } from './config.js';
import { DriveClient } from './client.js';
import { ensureFolderTree } from './bootstrap.js';
import { auditedJob } from './audit.js';
import { writeHeartbeat } from './heartbeat.js';
import type { FolderIdMap, GdriveConfig } from './types.js';

const log = createLogger('gdrive:runtime');

export interface GdriveRuntime {
  config: GdriveConfig;
  client: DriveClient;
  folders: FolderIdMap;
  audit: AuditTrail;
}

let runtimePromise: Promise<GdriveRuntime> | null = null;

/**
 * Get (or lazily initialize) the shared Drive runtime. Throws when disabled
 * or misconfigured — callers are background jobs that treat failure as
 * queue-and-retry, never the hot path.
 */
export function getGdriveRuntime(): Promise<GdriveRuntime> {
  if (!runtimePromise) {
    runtimePromise = initRuntime().catch((err) => {
      // Reset so a later fire retries a transient bootstrap failure instead
      // of pinning a rejected promise forever.
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}

async function initRuntime(): Promise<GdriveRuntime> {
  const config = loadGdriveConfig();
  if (!config.enabled) throw new Error('gdrive disabled (SUDO_GDRIVE != 1)');
  const client = new DriveClient(config);
  const audit = new AuditTrail();
  const folders = await auditedJob(audit, 'bootstrap', async () => {
    const map = await ensureFolderTree(client, config.rootFolderId!);
    return { result: map, filesTouched: Object.values(map) };
  });
  log.info({ folders: Object.keys(folders).length }, 'gdrive runtime initialized');
  return { config, client, folders, audit };
}

/** Cron entry: one heartbeat write. No-op (logged) when disabled. */
export async function runGdriveHeartbeatJob(): Promise<void> {
  if (!isGdriveEnabled()) {
    log.debug('gdrive heartbeat skipped — SUDO_GDRIVE != 1');
    return;
  }
  const rt = await getGdriveRuntime();
  await auditedJob(rt.audit, 'heartbeat', async () => {
    const fileId = await writeHeartbeat(rt.client, rt.folders);
    return { result: undefined, filesTouched: [fileId] };
  });
}

/** Test hook: reset the singleton between cases. */
export function _resetGdriveRuntime(): void {
  runtimePromise = null;
}
