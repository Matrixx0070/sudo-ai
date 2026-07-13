/**
 * @file versions-store.ts
 * @description On-disk skill version snapshots — skills/.versions/<name>/<seq>-<version>/
 * holding a full copy of the skill directory plus meta.json (version, sha256,
 * source, trustTier). Spec 9 step 5: rollback keeps the last 3 versions.
 *
 * This complements (does not replace) the SQLite SkillVersioning history: the
 * SQLite rows track single-file SKILL.md content for skill.apply/rollback;
 * snapshots here capture whole package directories (manifest.json + extra
 * files) so tarball installs and registry updates are fully restorable.
 */

import path from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { PROJECT_ROOT } from '../../shared/paths.js';
import { createLogger } from '../../shared/logger.js';
import type { SkillLockEntry } from './lockfile.js';

const log = createLogger('skills:versions-store');

/** How many snapshots to retain per skill (newest kept). */
export const KEEP_VERSIONS = 3;

export interface SnapshotMeta extends SkillLockEntry {
  snapshotAt: string;
}

export interface Snapshot {
  dir: string;
  seq: number;
  meta: SnapshotMeta;
}

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/i;

function versionsRoot(skillsRoot?: string): string {
  return path.join(skillsRoot ?? path.join(PROJECT_ROOT, 'skills'), '.versions');
}

function skillVersionsDir(name: string, skillsRoot?: string): string {
  if (!SAFE_NAME_RE.test(name)) throw new Error(`unsafe skill name for versions store: "${name}"`);
  return path.join(versionsRoot(skillsRoot), name);
}

/** List a skill's snapshots, oldest first. Unreadable entries are skipped. */
export function listSnapshots(name: string, skillsRoot?: string): Snapshot[] {
  const dir = skillVersionsDir(name, skillsRoot);
  if (!existsSync(dir)) return [];
  const out: Snapshot[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const seq = Number(entry.name.split('-', 1)[0]);
    if (!Number.isFinite(seq)) continue;
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, entry.name, 'meta.json'), 'utf8')) as SnapshotMeta;
      out.push({ dir: path.join(dir, entry.name), seq, meta });
    } catch {
      // corrupt snapshot — ignore rather than block rollback of good ones
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Snapshot the CURRENT contents of skills/<name>/ before a change, tagged with
 * the lock entry describing what is being replaced. Prunes to KEEP_VERSIONS.
 * Returns undefined when the skill directory does not exist yet (fresh install).
 */
export function snapshotSkill(name: string, current: SkillLockEntry, skillsRoot?: string): Snapshot | undefined {
  const root = skillsRoot ?? path.join(PROJECT_ROOT, 'skills');
  const skillDir = path.join(root, name);
  if (!SAFE_NAME_RE.test(name) || !existsSync(skillDir)) return undefined;

  const existing = listSnapshots(name, skillsRoot);
  const seq = (existing.at(-1)?.seq ?? 0) + 1;
  const meta: SnapshotMeta = { ...current, snapshotAt: new Date().toISOString() };
  const dest = path.join(skillVersionsDir(name, skillsRoot), `${seq}-${current.version}`);
  const tmp = `${dest}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  cpSync(skillDir, path.join(tmp, 'files'), { recursive: true });
  writeFileSync(path.join(tmp, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  renameSync(tmp, dest);

  pruneSnapshots(name, skillsRoot);
  log.info({ skill: name, version: current.version, seq }, 'Skill snapshot saved');
  return { dir: dest, seq, meta };
}

/** Keep only the newest KEEP_VERSIONS snapshots. */
export function pruneSnapshots(name: string, skillsRoot?: string): void {
  const snaps = listSnapshots(name, skillsRoot);
  for (const stale of snaps.slice(0, Math.max(0, snaps.length - KEEP_VERSIONS))) {
    rmSync(stale.dir, { recursive: true, force: true });
  }
}

/**
 * Restore a snapshot into skills/<name>/ (whole-directory replace) and consume
 * it (the restored snapshot is removed — restoring twice needs a re-snapshot).
 * Returns the restored meta so the caller can re-pin the lockfile.
 */
export function restoreSnapshot(name: string, snapshot: Snapshot, skillsRoot?: string): SnapshotMeta {
  const root = skillsRoot ?? path.join(PROJECT_ROOT, 'skills');
  const skillDir = path.join(root, name);
  const staged = `${skillDir}.restore-tmp`;
  rmSync(staged, { recursive: true, force: true });
  cpSync(path.join(snapshot.dir, 'files'), staged, { recursive: true });
  rmSync(skillDir, { recursive: true, force: true });
  renameSync(staged, skillDir);
  rmSync(snapshot.dir, { recursive: true, force: true });
  log.info({ skill: name, version: snapshot.meta.version }, 'Skill snapshot restored');
  return snapshot.meta;
}

/** Latest snapshot, if any. */
export function latestSnapshot(name: string, skillsRoot?: string): Snapshot | undefined {
  return listSnapshots(name, skillsRoot).at(-1);
}
