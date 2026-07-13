/**
 * @file pack.ts
 * @description Pack a skill directory into a versioned .tgz package and safely
 * extract one (Spec 9 step 2). A package is a gzipped tarball of the skill
 * directory (SKILL.md required, manifest.json included — synthesized when the
 * source dir lacks one). The tarball's SHA-256 is the integrity pin recorded
 * in skills.lock.json; a tampered tarball fails the pin check on install.
 *
 * Fail-closed: the scanner gate (CRITICAL blocks) runs BEFORE packing, and
 * extraction rejects symlinks, hardlinks, absolute or parent-escaping paths,
 * oversized entries, and oversized archives.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as tar from 'tar';
import { createLogger } from '../../shared/logger.js';
import { dataPath } from '../../shared/paths.js';
import { MANIFEST_FILENAME, findSkillMd, loadManifest, type SkillManifest } from './manifest.js';
import { scanSkillContent, type SkillScanVerdict } from './scan-gate.js';

const log = createLogger('skills:pack');

/** Byte cap for a whole package and any single file inside it. */
export const MAX_PACKAGE_BYTES = 1024 * 1024;
export const MAX_PACKAGE_FILES = 64;

export interface PackResult {
  tarballPath: string;
  sha256: string;
  manifest: SkillManifest;
  files: string[];
  scan: SkillScanVerdict;
}

export function sha256OfFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Recursively list regular files under a dir (relative paths, sorted). */
function listPackageFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // no dotfiles in packages
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink not allowed in a skill package: ${relPath}`);
    if (entry.isDirectory()) out.push(...listPackageFiles(abs, relPath));
    else if (entry.isFile()) out.push(relPath);
  }
  return out.sort();
}

/**
 * Validate a skill directory as a package candidate: SKILL.md present, valid
 * (or synthesizable) manifest, file/size caps, scanner verdict. Does not write.
 */
export function validateSkillPackage(skillDir: string): {
  manifest: SkillManifest;
  manifestSynthesized: boolean;
  files: string[];
  scan: SkillScanVerdict;
  problems: string[];
} {
  const problems: string[] = [];
  const skillMd = findSkillMd(skillDir);
  if (!skillMd) throw new Error(`no SKILL.md in ${skillDir} — not a skill directory`);
  const { manifest, synthesized } = loadManifest(skillDir);
  if (manifest.name !== path.basename(skillDir)) {
    problems.push(`manifest name "${manifest.name}" does not match directory "${path.basename(skillDir)}"`);
  }
  const files = listPackageFiles(skillDir);
  if (files.length > MAX_PACKAGE_FILES) problems.push(`too many files (${files.length} > ${MAX_PACKAGE_FILES})`);
  let total = 0;
  for (const f of files) {
    const size = statSync(path.join(skillDir, f)).size;
    total += size;
    if (size > MAX_PACKAGE_BYTES) problems.push(`file exceeds ${MAX_PACKAGE_BYTES} bytes: ${f}`);
  }
  if (total > MAX_PACKAGE_BYTES) problems.push(`package exceeds ${MAX_PACKAGE_BYTES} bytes total`);
  const scan = scanSkillContent(readFileSync(skillMd, 'utf8'), 'skill-pack');
  if (scan.severity === 'critical') problems.push(...scan.criticalReasons.map((r) => `scanner CRITICAL: ${r}`));
  return { manifest, manifestSynthesized: synthesized, files, scan, problems };
}

/**
 * Pack skills/<name>/ into <outDir>/<name>-<version>.tgz. The scanner gate and
 * validation run first; any problem aborts the pack (fail-closed).
 */
export async function packSkill(skillDir: string, outDir?: string): Promise<PackResult> {
  const v = validateSkillPackage(skillDir);
  if (v.problems.length > 0) {
    throw new Error(`pack blocked for ${skillDir}:\n- ${v.problems.join('\n- ')}`);
  }
  const dest = outDir ?? dataPath('skill-packages');
  mkdirSync(dest, { recursive: true });

  // Stage so a synthesized manifest.json is included without mutating skills/.
  const staging = mkdtempSync(path.join(tmpdir(), 'skill-pack-'));
  try {
    const stagedSkill = path.join(staging, v.manifest.name);
    mkdirSync(stagedSkill, { recursive: true });
    for (const f of v.files) {
      mkdirSync(path.dirname(path.join(stagedSkill, f)), { recursive: true });
      writeFileSync(path.join(stagedSkill, f), readFileSync(path.join(skillDir, f)));
    }
    if (!existsSync(path.join(stagedSkill, MANIFEST_FILENAME))) {
      writeFileSync(path.join(stagedSkill, MANIFEST_FILENAME), `${JSON.stringify(v.manifest, null, 2)}\n`, 'utf8');
    }
    const tarballPath = path.join(dest, `${v.manifest.name}-${v.manifest.version}.tgz`);
    await tar.create({ gzip: true, cwd: staging, file: tarballPath, portable: true }, [v.manifest.name]);
    const sha256 = sha256OfFile(tarballPath);
    log.info({ skill: v.manifest.name, version: v.manifest.version, tarballPath, sha256 }, 'Skill packed');
    return { tarballPath, sha256, manifest: v.manifest, files: v.files, scan: v.scan };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Safely extract a skill package tarball into destDir. Rejects links,
 * absolute/escaping paths, and oversized entries. Returns the single top-level
 * directory name the archive must contain.
 */
export async function extractSkillPackage(tarballPath: string, destDir: string): Promise<string> {
  if (statSync(tarballPath).size > MAX_PACKAGE_BYTES * 2) {
    throw new Error(`tarball exceeds ${MAX_PACKAGE_BYTES * 2} byte cap`);
  }
  mkdirSync(destDir, { recursive: true });
  let fileCount = 0;
  await tar.extract({
    file: tarballPath,
    cwd: destDir,
    strict: true,
    filter: (entryPath, entry) => {
      // tar types the callback for both create (Stats) and extract (ReadEntry);
      // extraction always passes ReadEntry, which carries `type`.
      const type = 'type' in entry ? String(entry.type) : 'File';
      if (type !== 'File' && type !== 'Directory') {
        throw new Error(`disallowed entry type "${type}" in package: ${entryPath}`);
      }
      const normalized = path.posix.normalize(entryPath);
      if (path.posix.isAbsolute(normalized) || normalized.startsWith('..')) {
        throw new Error(`unsafe path in package: ${entryPath}`);
      }
      if (type === 'File') {
        fileCount += 1;
        if (fileCount > MAX_PACKAGE_FILES) throw new Error(`too many files in package (> ${MAX_PACKAGE_FILES})`);
        if ((entry.size ?? 0) > MAX_PACKAGE_BYTES) throw new Error(`file exceeds ${MAX_PACKAGE_BYTES} bytes: ${entryPath}`);
      }
      return true;
    },
  });
  const tops = readdirSync(destDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (tops.length !== 1) throw new Error(`package must contain exactly one top-level skill directory (found ${tops.length})`);
  return tops[0].name;
}
