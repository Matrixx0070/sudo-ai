/**
 * @file installer.ts
 * @description Transactional skill-package install (Spec 9 steps 2-3). Two
 * sources, one pipeline:
 *   - installFromTarball: a packed .tgz (skill.pack output or a downloaded
 *     artifact) — the lockfile pins the TARBALL's SHA-256.
 *   - installFromRegistry: a SKILL.md from the registry index (existing
 *     SkillRegistryClient, checksum-verified) — the lockfile pins the
 *     CONTENT SHA-256 from the index.
 *
 * Every install: verify hash → scanner gate (CRITICAL blocks) → snapshot the
 * current version to skills/.versions/ → whole-directory swap → lockfile pin
 * → SQLite version row. Any failure after the swap restores the snapshot and
 * the previous lockfile entry — no half-applied state.
 */

import path from 'node:path';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createLogger } from '../../shared/logger.js';
import { PROJECT_ROOT, MIND_DB } from '../../shared/paths.js';
import { isProtectedPath } from '../../self-build/protected-paths.js';
import { blockIfProtected } from '../../self-build/path-guard.js';
import { SkillVersioning } from '../versioning.js';
import { SkillRegistryClient } from '../registry-client.js';
import { MANIFEST_FILENAME, parseManifest, findSkillMd, type SkillManifest } from './manifest.js';
import { readLockfile, updateLockEntry, writeLockfile, type SkillLockEntry } from './lockfile.js';
import { scanSkillContent, type SkillScanVerdict } from './scan-gate.js';
import { extractSkillPackage, sha256OfFile } from './pack.js';
import { snapshotSkill, restoreSnapshot } from './versions-store.js';
import { createHash } from 'node:crypto';

const log = createLogger('skills:installer');

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/i;

export interface InstallResult {
  name: string;
  version: string;
  skillDir: string;
  sha256: string;
  source: string;
  scan: SkillScanVerdict;
  changelog?: string;
  snapshotTaken: boolean;
}

export interface InstallOptions {
  skillsRoot?: string;
  mindDbPath?: string;
}

function skillsRootOf(opts: InstallOptions): string {
  return opts.skillsRoot ?? path.join(PROJECT_ROOT, 'skills');
}

/** Fail-closed target check: safe name, confined to skills/, not protected. */
function assertSafeTarget(name: string, skillsRoot: string): string {
  if (!SAFE_NAME_RE.test(name) || name.includes('..') || path.isAbsolute(name)) {
    throw new Error(`unsafe skill name: "${name}"`);
  }
  const target = path.join(skillsRoot, name);
  if (!target.startsWith(skillsRoot + path.sep)) throw new Error(`skill path escapes skills root: ${name}`);
  const rel = path.relative(PROJECT_ROOT, path.join(target, 'SKILL.md'));
  if (!rel.startsWith('..') && isProtectedPath(rel)) throw new Error(`target is a protected path: ${rel}`);
  const guard = blockIfProtected(path.join(target, 'SKILL.md'), PROJECT_ROOT);
  if (guard.blocked) throw new Error(guard.error ?? 'blocked by path-guard');
  return target;
}

/** Lock entry describing whatever is installed right now (for the snapshot). */
function currentLockEntry(name: string, skillsRoot: string): SkillLockEntry {
  const existing = readLockfile(skillsRoot).skills[name];
  if (existing) return existing;
  return { version: '0.0.0', sha256: '', source: 'local', trustTier: 'workspace', updatedAt: new Date().toISOString() };
}

/**
 * Shared transactional tail: snapshot current → swap stagedDir into place →
 * pin lockfile → SQLite row. Restores snapshot + prior lock on any failure.
 */
function applyStagedSkill(
  name: string,
  stagedDir: string,
  entry: SkillLockEntry,
  manifest: SkillManifest,
  opts: InstallOptions,
): { skillDir: string; snapshotTaken: boolean } {
  const skillsRoot = skillsRootOf(opts);
  const target = assertSafeTarget(name, skillsRoot);
  const priorLock = readLockfile(skillsRoot);
  const snapshot = snapshotSkill(name, currentLockEntry(name, skillsRoot), skillsRoot);

  try {
    const incoming = `${target}.incoming`;
    rmSync(incoming, { recursive: true, force: true });
    cpSync(stagedDir, incoming, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(incoming, target);
    updateLockEntry(name, entry, skillsRoot);

    // SQLite history row — best-effort (UNIQUE(skill,version) re-installs are fine to skip).
    try {
      const versioning = new SkillVersioning(opts.mindDbPath ?? MIND_DB);
      try {
        const skillMd = findSkillMd(target);
        if (skillMd) {
          versioning.saveVersion(name, entry.version, readFileSync(skillMd, 'utf8'), manifest.changelog ?? `installed from ${entry.source}`);
        }
      } finally {
        versioning.close();
      }
    } catch (err) {
      log.warn({ skill: name, err: err instanceof Error ? err.message : String(err) }, 'SQLite version row not saved (non-fatal)');
    }
    return { skillDir: target, snapshotTaken: snapshot !== undefined };
  } catch (err) {
    // Transactional restore: put the old directory and lockfile pin back.
    if (snapshot) {
      try { restoreSnapshot(name, snapshot, skillsRoot); } catch { /* directory restore failed — lockfile below still reverts */ }
    } else {
      rmSync(target, { recursive: true, force: true });
    }
    try { writeLockfile(priorLock, skillsRoot); } catch { /* keep original error */ }
    throw err;
  }
}

/**
 * Install a skill from a packed .tgz. `expectedSha256` (when provided, e.g.
 * from a registry pin or the pack report) must match the tarball bytes —
 * a tampered tarball is rejected BEFORE anything is extracted.
 */
export async function installFromTarball(
  tarballPath: string,
  expectedSha256?: string,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  if (!existsSync(tarballPath)) throw new Error(`tarball not found: ${tarballPath}`);
  const actual = sha256OfFile(tarballPath);
  if (expectedSha256 && actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Tarball checksum mismatch: expected ${expectedSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}… — refusing to install.`,
    );
  }

  const staging = mkdtempSync(path.join(tmpdir(), 'skill-install-'));
  try {
    const topDir = await extractSkillPackage(tarballPath, staging);
    const stagedSkill = path.join(staging, topDir);
    const manifestPath = path.join(stagedSkill, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) throw new Error(`package has no ${MANIFEST_FILENAME}`);
    const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== topDir) throw new Error(`manifest name "${manifest.name}" != package dir "${topDir}"`);
    const skillMd = findSkillMd(stagedSkill);
    if (!skillMd) throw new Error('package has no SKILL.md');

    const scan = scanSkillContent(readFileSync(skillMd, 'utf8'), 'skill-install');
    if (scan.severity === 'critical') {
      throw new Error(`scanner CRITICAL — install blocked:\n- ${scan.criticalReasons.join('\n- ')}`);
    }

    const entry: SkillLockEntry = {
      version: manifest.version,
      sha256: actual,
      source: `tarball:${path.basename(tarballPath)}`,
      trustTier: 'workspace',
      updatedAt: new Date().toISOString(),
    };
    const applied = applyStagedSkill(manifest.name, stagedSkill, entry, manifest, opts);
    log.info({ skill: manifest.name, version: manifest.version, sha256: actual }, 'Skill installed from tarball');
    return {
      name: manifest.name, version: manifest.version, skillDir: applied.skillDir,
      sha256: actual, source: entry.source, scan, changelog: manifest.changelog,
      snapshotTaken: applied.snapshotTaken,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Install (or update to) a registry version through the packaging pipeline:
 * checksum-verified fetch → scanner gate → snapshot → swap → lockfile pin.
 */
export async function installFromRegistry(
  name: string,
  version?: string,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const fetched = await new SkillRegistryClient().fetchSkill(name, version);
  const { entry: regEntry, markdown, sourceUrl } = fetched;

  const scan = scanSkillContent(markdown, 'skill-update');
  if (scan.severity === 'critical') {
    throw new Error(`scanner CRITICAL — "${regEntry.name}"@${regEntry.version} blocked:\n- ${scan.criticalReasons.join('\n- ')}`);
  }

  const manifest: SkillManifest = {
    name: regEntry.name,
    version: regEntry.version,
    description: regEntry.description,
    author: regEntry.author,
    changelog: regEntry.changelog,
  };
  const staging = mkdtempSync(path.join(tmpdir(), 'skill-registry-'));
  try {
    const stagedSkill = path.join(staging, regEntry.name);
    mkdirSync(stagedSkill, { recursive: true });
    writeFileSync(path.join(stagedSkill, 'SKILL.md'), markdown, 'utf8');
    writeFileSync(path.join(stagedSkill, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const lockEntry: SkillLockEntry = {
      version: regEntry.version,
      sha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
      source: sourceUrl,
      trustTier: 'workspace',
      updatedAt: new Date().toISOString(),
    };
    const applied = applyStagedSkill(regEntry.name, stagedSkill, lockEntry, manifest, opts);
    log.info({ skill: regEntry.name, version: regEntry.version, sourceUrl }, 'Skill installed from registry');
    return {
      name: regEntry.name, version: regEntry.version, skillDir: applied.skillDir,
      sha256: lockEntry.sha256, source: sourceUrl, scan, changelog: regEntry.changelog,
      snapshotTaken: applied.snapshotTaken,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
