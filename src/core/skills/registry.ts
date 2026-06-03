/**
 * @file registry.ts
 * @description SkillRegistry — versioned skill persistence via better-sqlite3.
 *
 * On startup, scans a skills directory, hashes each .md file, and registers
 * versioned entries. Same name + different sha256 = new version. Duplicate
 * (name, sha256) pairs are skipped.
 *
 * Frontmatter parsed from YAML-style --- delimiters. Body loaded on-demand.
 *
 * Tables:
 *   skills(id, name, version, frontmatter_json, body_md, sha256, created_at, archived_at)
 *   session_skills(session_id, skill_id, skill_name, version, attached_at)
 *
 * 20-skill-per-session cap enforced by attachToSession().
 * Types → registry-types.ts  |  SQL strings → registry-sql.ts
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import {
  SkillRegistryError,
  parseFrontmatter,
  rowToMeta,
  type SkillMeta,
  type SkillFull,
  type AttachedSkill,
} from './registry-types.js';
import { SQL, applyWave10Migrations, applyWave10Phase1NameMigration } from './registry-sql.js';
import { guardMemoryWrite, MemoryInjectionError } from '../memory/injection-scanner.js';
import type { SkillManifest, SkillTrustTier } from '../shared/wave10-types.js';
import { checkCapabilities } from './trust-policy.js';

export { SkillRegistryError } from './registry-types.js';
export type { SkillMeta, SkillFull, AttachedSkill } from './registry-types.js';

const log = createLogger('skills:registry');
const __dir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = path.join(__dir, 'sqlite-migrations', '001-skills.sql');
const DEFAULT_SKILLS_DIR = path.resolve('skills');
const SESSION_SKILL_CAP = 20;
const MAX_SKILL_BYTES = 1_048_576; // 1 MB — oversized files are skipped with a warning

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

export class SkillRegistry {
  private readonly db: Database.Database;
  private readonly skillsDir: string;
  // Prepared statements (typed as Database.Statement<unknown[], unknown> via cast)
  private readonly q: { [K in keyof typeof SQL]: Database.Statement };

  constructor(db: Database.Database, skillsDir: string = DEFAULT_SKILLS_DIR) {
    this.db = db;
    this.skillsDir = skillsDir;
    this.db.pragma('foreign_keys = ON');
    this.db.exec(readFileSync(MIGRATION_SQL, 'utf8'));
    // Wave 10: add trust_tier and caps_json columns (idempotent)
    applyWave10Migrations(this.db);
    // Wave 10 Phase 1: rename display-string skill names to canonical slugs (idempotent)
    applyWave10Phase1NameMigration(this.db);
    log.info('skills migrations applied');
    this.q = Object.fromEntries(
      Object.entries(SQL).map(([k, sql]) => [k, this.db.prepare(sql)]),
    ) as { [K in keyof typeof SQL]: Database.Statement };
  }

  // ---------------------------------------------------------------------------
  // Scan and register
  // ---------------------------------------------------------------------------

  scanAndRegister(): number {
    let dirEntries: import('node:fs').Dirent[];
    try {
      // Fix 1: use withFileTypes so Dirent.isFile() returns false for symlinks,
      // preventing symlink traversal to files outside the skills directory.
      dirEntries = readdirSync(this.skillsDir, { withFileTypes: true }).filter(
        (e) => e.isFile() && e.name.endsWith('.md'),
      );
    } catch (err) {
      log.warn({ err }, 'skills directory not readable — scan skipped');
      return 0;
    }

    let registered = 0;
    for (const entry of dirEntries) {
      const filename = entry.name;
      const fullPath = path.join(this.skillsDir, filename);
      try {
        // Fix 3: skip files exceeding 1 MB to prevent DoS via oversized bodies.
        const st = statSync(fullPath);
        if (st.size > MAX_SKILL_BYTES) {
          log.warn({ filename, size: st.size, maxBytes: MAX_SKILL_BYTES }, 'skill file exceeds size cap — skipped');
          continue;
        }
        const raw = readFileSync(fullPath, 'utf8');
        const sha256 = createHash('sha256').update(raw).digest('hex');
        const { meta, body } = parseFrontmatter(raw);
        const name = (meta['name'] as string | undefined) ?? filename.replace(/\.md$/, '');

        const existing = this.q.checkHash.get(name, sha256) as
          | { id: string; version: number } | undefined;
        if (existing) continue;

        const maxRow = this.q.maxVersion.get(name) as { max_ver: number | null };
        const version = (maxRow.max_ver ?? 0) + 1;

        // Extract trust tier and caps from frontmatter (Wave 10)
        const validTiers = new Set(['bundled', 'indexed', 'unreviewed', 'workspace']);
        const tierRaw = meta['trust_tier'] as string | undefined;
        const trust_tier: SkillTrustTier =
          tierRaw && validTiers.has(tierRaw)
            ? (tierRaw as SkillTrustTier)
            : 'bundled'; // local scanned skills default to bundled

        const capsRaw = meta['caps'];
        let caps: string[] = [];
        if (Array.isArray(capsRaw)) {
          caps = capsRaw as string[];
        } else if (typeof capsRaw === 'string' && capsRaw.length > 0) {
          caps = capsRaw.split(',').map((c: string) => c.trim()).filter(Boolean);
        }

        this.q.insert.run({
          id: randomUUID(), name, version,
          frontmatter_json: JSON.stringify(meta), body_md: body, sha256,
          created_at: new Date().toISOString(),
          trust_tier,
          caps_json: JSON.stringify(caps),
        });
        registered++;
        log.debug({ name, version }, 'skill registered');
      } catch (err) {
        log.warn({ err, filename }, 'failed to register skill file');
      }
    }
    log.info({ registered }, 'skill scan complete');
    return registered;
  }

  /**
   * Recursively scan `rootDir` for files named exactly `SKILL.md` and register
   * them as bundled skills.  Unlike scanAndRegister() (which reads flat `.md`
   * files), this method descends into subdirectories one level at a time so it
   * can discover the Wave 12 layout:
   *   src/core/skills/<category>/<name>/SKILL.md
   *
   * Only real files are visited (symlinks are skipped, matching the security
   * posture of scanAndRegister).  The 1 MB cap also applies.
   *
   * @param rootDir - Absolute path to the root skills source directory.
   * @returns The number of newly-registered bundled skills.
   */
  scanBundledSkills(rootDir: string): number {
    // Collect all SKILL.md file paths by walking the directory tree up to
    // MAX_DEPTH levels deep.  We do not recurse arbitrarily to avoid traversal
    // of deeply-nested or cyclic structures.
    const MAX_DEPTH = 5;
    const skillFiles: string[] = [];

    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // unreadable directory — skip silently
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name === 'SKILL.md') {
          skillFiles.push(path.join(dir, entry.name));
        } else if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), depth + 1);
        }
        // Symlinks are intentionally skipped (security: no symlink traversal)
      }
    };

    walk(rootDir, 0);

    let registered = 0;
    for (const fullPath of skillFiles) {
      try {
        const st = statSync(fullPath);
        if (st.size > MAX_SKILL_BYTES) {
          log.warn({ fullPath, size: st.size, maxBytes: MAX_SKILL_BYTES }, 'bundled SKILL.md exceeds size cap — skipped');
          continue;
        }
        const raw = readFileSync(fullPath, 'utf8');
        const sha256 = createHash('sha256').update(raw).digest('hex');
        const { meta, body } = parseFrontmatter(raw);
        const name = (meta['name'] as string | undefined) ?? path.basename(path.dirname(fullPath));

        const existing = this.q.checkHash.get(name, sha256) as
          | { id: string; version: number } | undefined;
        if (existing) continue;

        const maxRow = this.q.maxVersion.get(name) as { max_ver: number | null };
        const version = (maxRow.max_ver ?? 0) + 1;

        const validTiers = new Set(['bundled', 'indexed', 'unreviewed', 'workspace']);
        const tierRaw = meta['trust_tier'] as string | undefined;
        const trust_tier: SkillTrustTier =
          tierRaw && validTiers.has(tierRaw)
            ? (tierRaw as SkillTrustTier)
            : 'bundled'; // SKILL.md files default to bundled

        const capsRaw = meta['caps'];
        let caps: string[] = [];
        if (Array.isArray(capsRaw)) {
          caps = capsRaw as string[];
        } else if (typeof capsRaw === 'string' && capsRaw.length > 0) {
          caps = capsRaw.split(',').map((c: string) => c.trim()).filter(Boolean);
        }

        this.q.insert.run({
          id: randomUUID(), name, version,
          frontmatter_json: JSON.stringify(meta), body_md: body, sha256,
          created_at: new Date().toISOString(),
          trust_tier,
          caps_json: JSON.stringify(caps),
        });
        registered++;
        log.debug({ name, version, fullPath }, 'bundled skill registered');
      } catch (err) {
        log.warn({ err, fullPath }, 'failed to register bundled SKILL.md');
      }
    }
    log.info({ registered, rootDir }, 'bundled skill scan complete');
    return registered;
  }

  // ---------------------------------------------------------------------------
  // Queries — meta (cheap, no body_md)
  // ---------------------------------------------------------------------------

  getSkillMeta(name: string, version?: number): SkillMeta | null {
    if (version !== undefined) {
      const row = this.q.getByNameVersion.get(name, version) as Record<string, unknown> | undefined;
      return row ? rowToMeta(row) : null;
    }
    const row = this.q.getLatestByName.get(name) as Record<string, unknown> | undefined;
    return row ? rowToMeta(row) : null;
  }

  // ---------------------------------------------------------------------------
  // Queries — full body (on-demand, lazy)
  // ---------------------------------------------------------------------------

  loadSkillBody(name: string, version?: number): string | null {
    const row = version !== undefined
      ? this.q.getByNameVersion.get(name, version) as Record<string, unknown> | undefined
      : this.q.getLatestByName.get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    const raw = row['body_md'] as string;
    // Fix 4: Guard skill body for injection patterns before returning to agent context.
    try {
      return guardMemoryWrite(raw, 'skill:' + name);
    } catch (err) {
      if (err instanceof MemoryInjectionError) {
        log.error({ name, version, reasons: err.message }, 'loadSkillBody: injection detected — blocked');
        throw new SkillRegistryError(
          `skill body contains injection patterns: ${name}`,
          'SKILL_INJECTION_BLOCKED',
        );
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Import persistence — called by POST /v1/skills/import after duplicate check
  // ---------------------------------------------------------------------------

  /**
   * Persist a skill imported via SkillImporter into the registry.
   * Computes the next version number, assigns a new UUID, and inserts a row.
   *
   * Caller MUST verify the skill is not a duplicate (by name+contentHash)
   * before calling this method — registerFromImport does NOT re-check.
   *
   * @param manifest - The SkillManifest returned by SkillImporter.import().
   * @param raw      - The raw skill file content (used as body_md).
   * @throws SkillRegistryError with code 'INSERT_FAILED' on database write error.
   */
  registerFromImport(manifest: SkillManifest, raw: string): void {
    try {
      const maxRow = this.q.maxVersion.get(manifest.name) as { max_ver: number | null };
      const version = (maxRow.max_ver ?? 0) + 1;

      // Extract the agentskills.io canonical `id` from the raw SKILL.md frontmatter.
      // Fall back to manifest.name when the raw content has no id (legacy skills without
      // a dotted frontmatter id are still discoverable by name via the fallback lookup path).
      const { meta: rawFm } = parseFrontmatter(raw);
      const frontmatterId =
        typeof rawFm['id'] === 'string' && (rawFm['id'] as string).length > 0
          ? (rawFm['id'] as string)
          : manifest.name;

      // Wave 10 P1: pass through license, compatibility, display_name from raw frontmatter
      // so toPublicEntry() can expose them in registry responses.
      const frontmatter_json = JSON.stringify({
        id: frontmatterId,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        description: manifest.description,
        trust_tier: manifest.trust,
        caps: manifest.caps,
        source: manifest.source,
        ...(typeof rawFm['license'] === 'string' && { license: rawFm['license'] }),
        ...(Array.isArray(rawFm['compatibility']) && { compatibility: rawFm['compatibility'] }),
        ...(typeof rawFm['display_name'] === 'string' && { display_name: rawFm['display_name'] }),
      });
      this.q.insert.run({
        id: randomUUID(),
        name: manifest.name,
        version,
        frontmatter_json,
        body_md: raw,
        sha256: manifest.contentHash,
        created_at: new Date().toISOString(),
        trust_tier: manifest.trust,
        caps_json: JSON.stringify(manifest.caps),
      });
      log.debug({ name: manifest.name, version }, 'skill registered via registerFromImport');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SkillRegistryError('registerFromImport failed: ' + msg, 'INSERT_FAILED');
    }
  }

  // ---------------------------------------------------------------------------
  // Skills Hub integration — registry methods for installed skills
  // ---------------------------------------------------------------------------

  /**
   * Register a skill downloaded from the remote registry.
   * Used by SkillsHub.install() to persist registry skills into the local registry.
   *
   * @param entry - Registry skill entry from search/download.
   * @param skillContent - Raw SKILL.md content.
   * @throws SkillRegistryError on database write failure.
   */
  installFromRegistry(entry: import('./skills-hub-types.js').RegistrySkillEntry, skillContent: string): void {
    try {
      const maxRow = this.q.maxVersion.get(entry.name) as { max_ver: number | null };
      const version = (maxRow.max_ver ?? 0) + 1;

      const frontmatter_json = JSON.stringify({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        author: entry.author,
        description: entry.description,
        trust_tier: entry.trustTier,
        caps: entry.caps,
        source: entry.sourceUrl,
        license: entry.license,
        compatibility: entry.compatibility,
        display_name: entry.displayName,
      });

      this.q.insert.run({
        id: randomUUID(),
        name: entry.name,
        version,
        frontmatter_json,
        body_md: skillContent,
        sha256: createHash('sha256').update(skillContent).digest('hex'),
        created_at: new Date().toISOString(),
        trust_tier: entry.trustTier,
        caps_json: JSON.stringify(entry.caps),
      });
      log.debug({ name: entry.name, version }, 'skill registered from registry');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SkillRegistryError('installFromRegistry failed: ' + msg, 'INSERT_FAILED');
    }
  }

  /**
   * Update an existing skill with new content and version.
   * Creates a new version entry (skills are immutable, versioned by name).
   *
   * @param name - Skill name to update.
   * @param newContent - New SKILL.md content.
   * @param newVersion - New version string.
   * @returns True if update was applied.
   * @throws SkillRegistryError on database write failure.
   */
  updateSkill(name: string, newContent: string, newVersion: string): boolean {
    try {
      const { meta } = parseFrontmatter(newContent);
      const sha256 = createHash('sha256').update(newContent).digest('hex');

      // Check if this exact content already exists (skip duplicate)
      const existing = this.q.checkHash.get(name, sha256) as
        | { id: string; version: number } | undefined;
      if (existing) {
        log.debug({ name, version: existing.version }, 'skill update skipped — same content');
        return false;
      }

      const maxRow = this.q.maxVersion.get(name) as { max_ver: number | null };
      const version = (maxRow.max_ver ?? 0) + 1;

      const capsRaw = meta['caps'];
      let caps: string[] = [];
      if (Array.isArray(capsRaw)) {
        caps = capsRaw as string[];
      } else if (typeof capsRaw === 'string' && capsRaw.length > 0) {
        caps = capsRaw.split(',').map((c: string) => c.trim()).filter(Boolean);
      }

      const validTiers = new Set(['bundled', 'indexed', 'unreviewed', 'workspace']);
      const tierRaw = meta['trust_tier'] as string | undefined;
      const trust_tier = tierRaw && validTiers.has(tierRaw)
        ? (tierRaw as import('../shared/wave10-types.js').SkillTrustTier)
        : 'unreviewed';

      this.q.insert.run({
        id: randomUUID(),
        name,
        version,
        frontmatter_json: JSON.stringify(meta),
        body_md: newContent,
        sha256,
        created_at: new Date().toISOString(),
        trust_tier,
        caps_json: JSON.stringify(caps),
      });
      log.info({ name, version: newVersion }, 'skill updated');
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SkillRegistryError('updateSkill failed: ' + msg, 'UPDATE_FAILED');
    }
  }

  /**
   * Get list of installed skills, optionally filtered by source.
   * Returns skills with version, trust tier, and capability metadata.
   *
   * @param source - Optional filter by install source ('bundled', 'registry', 'import', 'workspace').
   * @returns Array of installed skill metadata.
   */
  getInstalledSkills(source?: string): import('./skills-hub-types.js').InstalledSkill[] {
    try {
      const rows = this.q.list.all(1000, 0) as Record<string, unknown>[];
      const skills: import('./skills-hub-types.js').InstalledSkill[] = [];

      for (const row of rows) {
        const frontmatter = JSON.parse((row['frontmatter_json'] as string) || '{}') as Record<string, unknown>;
        const sourceVal = (frontmatter['source'] as string) || '';
        const trustTierRaw = (row['trust_tier'] as string) || 'unreviewed';
        const capsJson = (row['caps_json'] as string) || '[]';

        // Map source string to install source type
        let installSource: import('./skills-hub-types.js').SkillInstallSource = 'import';
        if (sourceVal.includes('registry:')) {
          installSource = 'registry';
        } else if (sourceVal.includes('github:') || sourceVal.includes('openclaw:') || sourceVal.includes('openjarvis:')) {
          installSource = 'import';
        } else if (frontmatter['trust_tier'] === 'bundled') {
          installSource = 'bundled';
        }

        if (source && installSource !== source) {
          continue;
        }

        const validTiers = new Set(['bundled', 'indexed', 'unreviewed', 'workspace']);
        const trustTier = validTiers.has(trustTierRaw)
          ? (trustTierRaw as import('../shared/wave10-types.js').SkillTrustTier)
          : 'unreviewed';

        skills.push({
          id: (row['id'] as string) || '',
          name: (row['name'] as string) || '',
          version: String(row['version'] ?? '1'),
          installedAt: (row['created_at'] as string) || new Date().toISOString(),
          source: installSource,
          registryId: (frontmatter['id'] as string) || undefined,
          trustTier,
          caps: JSON.parse(capsJson) as string[],
          enabled: !(row['archived_at'] as string),
        });
      }

      return skills;
    } catch (err: unknown) {
      log.error({ err }, 'failed to get installed skills');
      return [];
    }
  }

  getSkillById(id: string): SkillFull | null {
    const row = this.q.getById.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const raw = row['body_md'] as string;
    // Fix 4: Guard skill body for injection patterns before returning to agent context.
    let safeBody: string;
    try {
      safeBody = guardMemoryWrite(raw, 'skill:' + id);
    } catch (err) {
      if (err instanceof MemoryInjectionError) {
        log.error({ id, reasons: err.message }, 'getSkillById: injection detected — blocked');
        throw new SkillRegistryError(
          `skill body contains injection patterns: ${id}`,
          'SKILL_INJECTION_BLOCKED',
        );
      }
      throw err;
    }
    return { ...rowToMeta(row), body_md: safeBody };
  }

  getSkillByIdVersion(id: string, version: number): SkillFull | null {
    const row = this.q.getByIdVersion.get(id, version) as Record<string, unknown> | undefined;
    if (!row) return null;
    const raw = row['body_md'] as string;
    let safeBody: string;
    try {
      safeBody = guardMemoryWrite(raw, 'skill:' + id);
    } catch (err) {
      if (err instanceof MemoryInjectionError) {
        log.error({ id, version, reasons: err.message }, 'getSkillByIdVersion: injection detected — blocked');
        throw new SkillRegistryError(
          `skill body contains injection patterns: ${id}`,
          'SKILL_INJECTION_BLOCKED',
        );
      }
      throw err;
    }
    return { ...rowToMeta(row), body_md: safeBody };
  }

  list(limit = 50, offset = 0): SkillMeta[] {
    return (this.q.list.all(limit, offset) as Record<string, unknown>[]).map(rowToMeta);
  }

  getVersions(name: string): SkillMeta[] {
    return (this.q.versions.all(name) as Record<string, unknown>[]).map(rowToMeta);
  }

  // ---------------------------------------------------------------------------
  // Session attachment (20-cap)
  // ---------------------------------------------------------------------------

  attachToSession(sessionId: string, skillId: string, version?: number): AttachedSkill {
    if (!sessionId || !skillId) {
      throw new SkillRegistryError('sessionId and skillId are required', 'INVALID_INPUT');
    }
    // Use metadata-only lookup for attach — body is not needed here and injection
    // scanning the body would block attaching skills in strict mode unnecessarily.
    const metaRow = version !== undefined
      ? this.q.getByIdVersion.get(skillId, version) as Record<string, unknown> | undefined
      : this.q.getById.get(skillId) as Record<string, unknown> | undefined;
    const skill = metaRow ? rowToMeta(metaRow) : null;
    if (!skill) throw new SkillRegistryError(`skill not found: ${skillId}`, 'NOT_FOUND');
    if (skill.archived_at) {
      throw new SkillRegistryError(`skill is archived: ${skillId}`, 'ARCHIVED');
    }

    // Wave 10: capability check against trust tier policy
    const rawTier = (metaRow as Record<string, unknown>)?.['trust_tier'] as string | undefined;
    const validTiers = new Set(['bundled', 'indexed', 'unreviewed', 'workspace']);
    const trust_tier: SkillTrustTier =
      rawTier && validTiers.has(rawTier)
        ? (rawTier as SkillTrustTier)
        : 'unreviewed';

    const capsJson = (metaRow as Record<string, unknown>)?.['caps_json'] as string | undefined;
    const caps: string[] = capsJson ? (JSON.parse(capsJson) as string[]) : [];
    if (caps.length > 0) {
      const capResult = checkCapabilities(caps, trust_tier);
      if (!capResult.granted) {
        throw new SkillRegistryError(
          `Skill "${skill.name}" requires capabilities not allowed at tier "${trust_tier}": ${capResult.missing.join(', ')}`,
          'CAP_VIOLATION',
        );
      }
    }

    const alreadyAttached = this.q.getAttachedEntry.get(sessionId, skillId) as
      | AttachedSkill | undefined;
    if (!alreadyAttached) {
      const { cnt } = this.q.attachCount.get(sessionId) as { cnt: number };
      if (cnt >= SESSION_SKILL_CAP) {
        throw new SkillRegistryError(
          `session ${sessionId} has reached the ${SESSION_SKILL_CAP}-skill cap`,
          'CAP_EXCEEDED',
        );
      }
    }

    const attached_at = new Date().toISOString();
    this.q.attach.run({
      session_id: sessionId, skill_id: skillId,
      skill_name: skill.name, version: skill.version, attached_at,
    });
    return { session_id: sessionId, skill_id: skillId,
      skill_name: skill.name, version: skill.version, attached_at };
  }

  detachFromSession(sessionId: string, skillId: string): void {
    if (!sessionId || !skillId) {
      throw new SkillRegistryError('sessionId and skillId are required', 'INVALID_INPUT');
    }
    this.q.detach.run(sessionId, skillId);
  }

  listAttached(sessionId: string): AttachedSkill[] {
    if (!sessionId) throw new SkillRegistryError('sessionId is required', 'INVALID_INPUT');
    return this.q.listAttached.all(sessionId) as AttachedSkill[];
  }

  // ---------------------------------------------------------------------------
  // Archive (soft-delete — retains all history)
  // ---------------------------------------------------------------------------

  archive(id: string): void {
    const row = this.q.getById.get(id) as Record<string, unknown> | undefined;
    if (!row) throw new SkillRegistryError(`skill not found: ${id}`, 'NOT_FOUND');
    this.q.archive.run(new Date().toISOString(), id);
    log.info({ id }, 'skill archived');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _idForName(name: string): string | null {
    const row = this.q.getLatestByName.get(name) as { id: string } | undefined;
    return row ? row.id : null;
  }
}
