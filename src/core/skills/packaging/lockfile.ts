/**
 * @file lockfile.ts
 * @description skills.lock.json — the pinned record of every packaged skill:
 * version, SHA-256 (of the installed content or tarball), source, trust tier,
 * and install time. Spec 9 step 1. The lockfile is what skill.update diffs
 * against the registry index, and what a tampered re-install is caught by.
 *
 * Writes are atomic (tmp + rename) and confined to the skills root.
 */

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { PROJECT_ROOT } from '../../shared/paths.js';
import type { SkillTrustTier } from '../../shared/wave10-types.js';

export const LOCKFILE_NAME = 'skills.lock.json';

export interface SkillLockEntry {
  version: string;
  /** Lowercase hex SHA-256 — of the tarball for tarball installs, of the SKILL.md bytes for registry installs. */
  sha256: string;
  /** Where the skill came from: 'local' (init/apply), a tarball path, or a registry index URL. */
  source: string;
  trustTier: SkillTrustTier;
  updatedAt: string;
}

export interface SkillLockfile {
  schema: 1;
  skills: Record<string, SkillLockEntry>;
}

export function lockfilePath(skillsRoot?: string): string {
  return path.join(skillsRoot ?? path.join(PROJECT_ROOT, 'skills'), LOCKFILE_NAME);
}

/** Read the lockfile; a missing or unreadable file yields an empty lockfile. */
export function readLockfile(skillsRoot?: string): SkillLockfile {
  const p = lockfilePath(skillsRoot);
  if (!existsSync(p)) return { schema: 1, skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as SkillLockfile;
    if (parsed?.schema !== 1 || typeof parsed.skills !== 'object' || parsed.skills === null) {
      return { schema: 1, skills: {} };
    }
    return { schema: 1, skills: parsed.skills };
  } catch {
    return { schema: 1, skills: {} };
  }
}

/** Atomic write (tmp + rename), stable key order for clean diffs. */
export function writeLockfile(lock: SkillLockfile, skillsRoot?: string): string {
  const p = lockfilePath(skillsRoot);
  mkdirSync(path.dirname(p), { recursive: true });
  const sorted: SkillLockfile = {
    schema: 1,
    skills: Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))),
  };
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  renameSync(tmp, p);
  return p;
}

/** Upsert one skill's pin. Returns the written lockfile path. */
export function updateLockEntry(name: string, entry: SkillLockEntry, skillsRoot?: string): string {
  const lock = readLockfile(skillsRoot);
  lock.skills[name] = entry;
  return writeLockfile(lock, skillsRoot);
}

/** Drop a skill's pin (uninstall / rollback-to-nothing). No-op when absent. */
export function removeLockEntry(name: string, skillsRoot?: string): void {
  const lock = readLockfile(skillsRoot);
  if (!(name in lock.skills)) return;
  delete lock.skills[name];
  writeLockfile(lock, skillsRoot);
}
