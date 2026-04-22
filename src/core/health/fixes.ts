/**
 * @file fixes.ts
 * @description Auto-fix / recovery routines for the SUDO-AI health subsystem.
 *
 * Each exported function attempts a specific in-process recovery action.
 * No service restarts are performed.
 *
 * Functions:
 *  - fixLogRotation   — gzip-rotate the active log file when it exceeds 50 MB
 *  - fixDiskSpace     — delete log archives >7 days old and stale cache files
 *  - fixMemory        — trigger V8 GC if available (requires --expose-gc flag)
 *  - fixBrainCooldown — emit process signal for brain to reset model cooldowns
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { createLogger } from '../shared/logger.js';
import { DATA_DIR, LOG_FILE } from './checks.js';

const log = createLogger('health:fixes');

// ---------------------------------------------------------------------------
// Log rotation
// ---------------------------------------------------------------------------

/**
 * Gzip the current log file into a timestamped archive, then truncate it.
 * Safe to call while the process is writing — truncation is atomic on Linux.
 */
export async function fixLogRotation(): Promise<void> {
  const archive = `${LOG_FILE}.${Date.now()}.gz`;
  try {
    await new Promise<void>((resolve, reject) => {
      const src = fs.createReadStream(LOG_FILE);
      const dst = fs.createWriteStream(archive);
      const gz  = zlib.createGzip();

      src.pipe(gz).pipe(dst);
      dst.on('finish', resolve);
      dst.on('error', reject);
      src.on('error', reject);
    });

    // Truncate the original after successful archive write.
    fs.writeFileSync(LOG_FILE, '');
    log.info({ archive }, 'Log rotated successfully');
  } catch (err) {
    log.error({ err: String(err) }, 'fixLogRotation failed');
  }
}

// ---------------------------------------------------------------------------
// Disk space cleanup
// ---------------------------------------------------------------------------

/**
 * Free disk space by:
 *  1. Deleting gzipped log archives older than 7 days.
 *  2. Deleting single-file entries in data/cache older than 24 hours.
 */
export async function fixDiskSpace(): Promise<void> {
  try {
    const logsDir   = path.join(DATA_DIR, 'logs');
    const logCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

    if (fs.existsSync(logsDir)) {
      for (const entry of fs.readdirSync(logsDir)) {
        // Only target compressed archives, never the live log.
        if (!/\.gz$/.test(entry)) continue;
        const full = path.join(logsDir, entry);
        try {
          if (fs.statSync(full).mtimeMs < logCutoff) {
            fs.unlinkSync(full);
            log.info({ file: entry }, 'Removed old log archive');
          }
        } catch { /* skip locked / race-deleted files */ }
      }
    }

    const cacheDir    = path.join(DATA_DIR, 'cache');
    const cacheCutoff = Date.now() - 24 * 60 * 60 * 1000;

    if (fs.existsSync(cacheDir)) {
      for (const entry of fs.readdirSync(cacheDir)) {
        const full = path.join(cacheDir, entry);
        try {
          const stat = fs.statSync(full);
          if (stat.isFile() && stat.mtimeMs < cacheCutoff) {
            fs.unlinkSync(full);
            log.info({ file: entry }, 'Removed stale cache file');
          }
        } catch { /* skip */ }
      }
    }
  } catch (err) {
    log.error({ err: String(err) }, 'fixDiskSpace failed');
  }
}

// ---------------------------------------------------------------------------
// Memory pressure
// ---------------------------------------------------------------------------

/**
 * Attempt to trigger V8 garbage collection.
 * Effective only when the process was started with --expose-gc.
 * Otherwise logs an informational message — this is not an error.
 */
export async function fixMemory(): Promise<void> {
  try {
    const g = globalThis as typeof globalThis & { gc?: () => void };
    if (typeof g.gc === 'function') {
      g.gc();
      log.info('GC triggered via global.gc()');
    } else {
      log.info('global.gc not exposed — start with --expose-gc to enable forced GC');
    }
  } catch (err) {
    log.error({ err: String(err) }, 'fixMemory failed');
  }
}

// ---------------------------------------------------------------------------
// Brain cooldown reset
// ---------------------------------------------------------------------------

/**
 * Emit a process-level event that the brain module can listen for to reset
 * model cooldown timers. Uses a custom event name to avoid hard coupling.
 */
export async function fixBrainCooldown(): Promise<void> {
  try {
    // The brain module can subscribe: process.on('sudo:brain:reset-cooldowns', handler)
    process.emit('sudo:brain:reset-cooldowns' as NodeJS.Signals);
    log.info('Brain cooldown reset signal emitted');
  } catch (err) {
    log.error({ err: String(err) }, 'fixBrainCooldown failed');
  }
}
