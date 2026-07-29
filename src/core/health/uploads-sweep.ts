/**
 * @file uploads-sweep.ts
 * @description TTL garbage collection for the uploads directories — where
 * inbound Telegram media (photos/voice/documents via
 * src/core/channels/telegram.ts, anchored at DATA_DIR/uploads) and browser
 * uploads (src/core/channels/web.ts, anchored at PROJECT_ROOT/data/uploads)
 * are saved. The two resolve to the same directory at default config but
 * diverge when the DATA_DIR env override is set, so the sweep covers both
 * (deduped). Nothing else ever deletes those files, so disk grows forever.
 *
 * Both writers save FLAT files directly under the uploads dir (no subdirs),
 * so the sweep deliberately does not recurse: it deletes only regular files
 * directly inside the dir, older than the TTL by mtime. `lstatSync` is used so
 * symlinks are never followed (a symlink is skipped, not deleted).
 *
 * Env: SUDO_UPLOADS_TTL_DAYS (default 30); 0 or negative disables the sweep.
 * Never throws — per-file try/catch, ENOENT races tolerated, returns a report.
 * Costs no tokens.
 */

import { lstatSync, readdirSync, unlinkSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR, PROJECT_ROOT } from '../shared/paths.js';

const log = createLogger('health:uploads-sweep');

const DAY_MS = 86_400_000;

/** Same resolution as the download code (telegram.ts UPLOAD_DIR). */
export const UPLOADS_DIR: string = path.join(DATA_DIR, 'uploads');

/**
 * All upload dirs the writers use: telegram.ts (DATA_DIR/uploads) and
 * web.ts (PROJECT_ROOT/data/uploads). Identical unless DATA_DIR is overridden.
 */
export const UPLOADS_DIRS: string[] = [
  ...new Set([
    path.resolve(UPLOADS_DIR),
    path.resolve(PROJECT_ROOT, 'data', 'uploads'),
  ]),
];

export interface UploadsSweepReport {
  deleted: number;
  bytesFreed: number;
  skipped: boolean;
}

/**
 * Sweep expired files. With an explicit `uploadsDir`, only that dir is swept
 * (test seam); by default every dir in UPLOADS_DIRS is swept.
 */
export function runUploadsSweep(uploadsDir?: string): UploadsSweepReport {
  const report: UploadsSweepReport = { deleted: 0, bytesFreed: 0, skipped: false };

  const raw = Number(process.env['SUDO_UPLOADS_TTL_DAYS'] ?? 30);
  const ttlDays = Number.isFinite(raw) ? raw : 30;
  if (ttlDays <= 0) {
    report.skipped = true;
    log.info({ ttlDays }, 'uploads sweep disabled (SUDO_UPLOADS_TTL_DAYS<=0)');
    return report;
  }

  const cutoffMs = Date.now() - ttlDays * DAY_MS;
  const dirs = uploadsDir ? [uploadsDir] : UPLOADS_DIRS;
  for (const dir of dirs) sweepDir(dir, cutoffMs, report);

  log.info(
    { deleted: report.deleted, bytesFreed: report.bytesFreed, ttlDays, dirs: dirs.length },
    'uploads sweep complete',
  );
  return report;
}

function sweepDir(dir: string, cutoffMs: number, report: UploadsSweepReport): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Dir missing (nothing ever uploaded) or unreadable — nothing to sweep.
    return;
  }

  for (const name of names) {
    const fp = path.join(dir, name);
    try {
      // lstat: never follow symlinks; only regular files directly in the dir.
      const st = lstatSync(fp);
      if (!st.isFile()) continue;
      if (st.mtimeMs >= cutoffMs) continue;
      unlinkSync(fp);
      report.deleted++;
      report.bytesFreed += st.size;
      log.debug({ file: name, bytes: st.size }, 'expired upload deleted');
    } catch {
      // ENOENT race (file deleted between readdir and lstat/unlink) or
      // permission oddity — skip this entry, keep sweeping.
    }
  }
}
