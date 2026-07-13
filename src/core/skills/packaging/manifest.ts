/**
 * @file manifest.ts
 * @description Skill package manifest (manifest.json) — the versioned identity
 * of a skill as a package rather than a loose SKILL.md. Spec 9 step 1.
 *
 * A manifest lives next to SKILL.md inside skills/<name>/ and inside every
 * packed tarball. When a skill has no manifest.json yet, one is synthesized
 * from SKILL.md frontmatter (name/version/description) so legacy skills can be
 * packed without hand-editing.
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export const MANIFEST_FILENAME = 'manifest.json';

/** Strict x.y.z — matches validateSemver in versioning-io.ts. */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/i;

export interface SkillManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Tool names the skill expects; informational for the router/policy. */
  allowedTools?: string[];
  /** Minimum sudo-ai version the skill needs (x.y.z). */
  minAgentVersion?: string;
  /** One-line summary of what changed in this version. */
  changelog?: string;
}

/** Validate a parsed manifest; returns the reasons it is malformed (empty = ok). */
export function validateManifest(m: unknown): string[] {
  const reasons: string[] = [];
  const man = m as Partial<SkillManifest> | null;
  if (!man || typeof man !== 'object') return ['manifest is not an object'];
  if (typeof man.name !== 'string' || !NAME_RE.test(man.name)) reasons.push('invalid name');
  if (typeof man.version !== 'string' || !SEMVER_RE.test(man.version)) {
    reasons.push(`invalid version (want x.y.z): "${String(man.version)}"`);
  }
  if (man.minAgentVersion !== undefined && (typeof man.minAgentVersion !== 'string' || !SEMVER_RE.test(man.minAgentVersion))) {
    reasons.push('invalid minAgentVersion (want x.y.z)');
  }
  if (man.allowedTools !== undefined
    && (!Array.isArray(man.allowedTools) || man.allowedTools.some((t) => typeof t !== 'string'))) {
    reasons.push('allowedTools must be a string array');
  }
  return reasons;
}

/** Parse + validate manifest JSON text. Throws with the malformation reasons. */
export function parseManifest(jsonText: string): SkillManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  const reasons = validateManifest(parsed);
  if (reasons.length > 0) throw new Error(`invalid manifest.json — ${reasons.join('; ')}`);
  return parsed as SkillManifest;
}

/**
 * Compare two strict x.y.z versions. Returns -1 / 0 / 1 (a<b / a==b / a>b).
 * The repo pins strict triples (validateSemver), so no range/prerelease logic.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/** Pull a simple scalar frontmatter value out of a SKILL.md. */
function frontmatterValue(markdown: string, key: string): string | undefined {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const m = fm[1].match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
  return m?.[1]?.trim() || undefined;
}

/**
 * Load a skill directory's manifest: manifest.json when present, otherwise
 * synthesized from SKILL.md frontmatter (version defaults to 0.1.0).
 */
export function loadManifest(skillDir: string): { manifest: SkillManifest; synthesized: boolean } {
  const manifestPath = path.join(skillDir, MANIFEST_FILENAME);
  if (existsSync(manifestPath)) {
    return { manifest: parseManifest(readFileSync(manifestPath, 'utf8')), synthesized: false };
  }
  const skillMd = findSkillMd(skillDir);
  if (!skillMd) throw new Error(`no ${MANIFEST_FILENAME} and no SKILL.md in ${skillDir}`);
  const markdown = readFileSync(skillMd, 'utf8');
  const rawVersion = frontmatterValue(markdown, 'version');
  const manifest: SkillManifest = {
    name: frontmatterValue(markdown, 'name') ?? path.basename(skillDir),
    version: rawVersion && SEMVER_RE.test(rawVersion) ? rawVersion : '0.1.0',
    description: frontmatterValue(markdown, 'description'),
  };
  const reasons = validateManifest(manifest);
  if (reasons.length > 0) throw new Error(`cannot synthesize manifest for ${skillDir} — ${reasons.join('; ')}`);
  return { manifest, synthesized: true };
}

/** Locate the SKILL.md (case-insensitive, matching markdown-loader behavior). */
export function findSkillMd(skillDir: string): string | undefined {
  for (const candidate of ['SKILL.md', 'skill.md', 'Skill.md']) {
    const p = path.join(skillDir, candidate);
    if (existsSync(p)) return p;
  }
  return undefined;
}
