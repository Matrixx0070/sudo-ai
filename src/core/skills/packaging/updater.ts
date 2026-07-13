/**
 * @file updater.ts
 * @description skill update checks + application (Spec 9 step 3). Diffs the
 * skills.lock.json pins against the registry index, reports available updates
 * with changelog / diffstat / scanner-delta, and applies them per skill
 * through the transactional installer — one bad skill never blocks or
 * half-applies the others, and a scanner-CRITICAL candidate aborts that
 * skill's update entirely.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createLogger } from '../../shared/logger.js';
import { PROJECT_ROOT } from '../../shared/paths.js';
import { SkillRegistryClient } from '../registry-client.js';
import { compareSemver, findSkillMd } from './manifest.js';
import { readLockfile } from './lockfile.js';
import { scanDelta, type SkillScanVerdict } from './scan-gate.js';
import { installFromRegistry, type InstallResult, type InstallOptions } from './installer.js';

const log = createLogger('skills:updater');

export interface AvailableUpdate {
  name: string;
  current: string;
  latest: string;
  changelog?: string;
  sha256: string;
  /** Lines added/removed between the installed SKILL.md and the candidate. */
  diffstat: { added: number; removed: number };
  /** Scanner verdict for the candidate + reasons NEW relative to installed. */
  scan: SkillScanVerdict;
  scanNewReasons: string[];
}

export interface UpdateCheckResult {
  updates: AvailableUpdate[];
  /** Locked skills with no registry entry (local/tarball-only). */
  unmanaged: string[];
  /** Skills whose candidate could not be fetched/verified — checked per skill
   * so one bad entry never hides the others' updates. */
  errors: Array<{ name: string; error: string }>;
  sourceUrl: string;
}

export interface ApplyUpdatesResult {
  applied: InstallResult[];
  failed: Array<{ name: string; error: string }>;
}

function diffstat(oldText: string, newText: string): { added: number; removed: number } {
  const oldLines = new Set(oldText.split('\n'));
  const newLines = new Set(newText.split('\n'));
  let added = 0;
  let removed = 0;
  for (const l of newLines) if (!oldLines.has(l)) added += 1;
  for (const l of oldLines) if (!newLines.has(l)) removed += 1;
  return { added, removed };
}

/**
 * Find lockfile-pinned skills with a strictly newer version in the registry.
 * Fetches each candidate (checksum-verified) to compute diffstat + scan delta,
 * but writes NOTHING — this is the read-only half `skill.update` shows before
 * the owner approves.
 */
export async function checkForUpdates(opts: InstallOptions = {}): Promise<UpdateCheckResult> {
  const skillsRoot = opts.skillsRoot ?? path.join(PROJECT_ROOT, 'skills');
  const lock = readLockfile(skillsRoot);
  const client = new SkillRegistryClient();
  const { index, sourceUrl } = await client.fetchIndex();

  const updates: AvailableUpdate[] = [];
  const unmanaged: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  for (const [name, pinned] of Object.entries(lock.skills)) {
    const entry = index.skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!entry) {
      unmanaged.push(name);
      continue;
    }
    if (compareSemver(entry.version, pinned.version) <= 0) continue;

    try {
      const fetched = await client.fetchSkill(entry.name, entry.version);
      const skillMd = findSkillMd(path.join(skillsRoot, name));
      const installed = skillMd ? readFileSync(skillMd, 'utf8') : undefined;
      const delta = scanDelta(installed, fetched.markdown);
      updates.push({
        name,
        current: pinned.version,
        latest: entry.version,
        changelog: entry.changelog,
        sha256: entry.sha256,
        diffstat: diffstat(installed ?? '', fetched.markdown),
        scan: delta.verdict,
        scanNewReasons: delta.newReasons,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ skill: name, err: msg }, 'Update candidate fetch/verify failed — skill skipped');
      errors.push({ name, error: msg });
    }
  }
  log.info({ updates: updates.length, unmanaged: unmanaged.length, errors: errors.length, sourceUrl }, 'Skill update check complete');
  return { updates, unmanaged, errors, sourceUrl };
}

/**
 * Apply updates transactionally PER SKILL: each goes through the installer's
 * snapshot → swap → lockfile pipeline independently. A scanner-CRITICAL or
 * checksum failure aborts only that skill (recorded in `failed`) — the rest
 * proceed, and nothing is ever left half-applied (acceptance 5).
 */
export async function applyUpdates(
  updates: Array<{ name: string; latest: string }>,
  opts: InstallOptions = {},
): Promise<ApplyUpdatesResult> {
  const applied: InstallResult[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const u of updates) {
    try {
      applied.push(await installFromRegistry(u.name, u.latest, opts));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ skill: u.name, version: u.latest, err: msg }, 'Skill update failed (skill left at prior version)');
      failed.push({ name: u.name, error: msg });
    }
  }
  return { applied, failed };
}
