/**
 * @file registry-types.ts
 * @description Types, error class, and frontmatter parser for SkillRegistry.
 * Extracted to keep registry.ts under 300 lines.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillMeta {
  id: string;
  name: string;
  version: number;
  frontmatter: Record<string, unknown>;
  sha256: string;
  created_at: string;
  archived_at: string | null;
}

export interface SkillFull extends SkillMeta {
  body_md: string;
}

export interface AttachedSkill {
  session_id: string;
  skill_id: string;
  skill_name: string;
  version: number;
  attached_at: string;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class SkillRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SkillRegistryError';
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parser (minimal — no external dependency)
// ---------------------------------------------------------------------------

/**
 * Parse YAML-style --- frontmatter from a markdown file.
 * Supports scalar values and bracket arrays: [a, b, c]
 */
export function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const lines = raw.split('\n');
  if (lines[0]?.trimEnd() !== '---') return { meta: {}, body: raw };
  const endIdx = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (endIdx === -1) return { meta: {}, body: raw };

  const meta: Record<string, unknown> = {};
  for (const line of lines.slice(1, endIdx)) {
    // Skip indented continuation lines: agentskills.io allows nested maps
    // (e.g. a `metadata:` block) whose inner `key: value` lines would
    // otherwise leak into the top-level meta and clobber real keys.
    if (/^\s/.test(line)) continue;
    const colonAt = line.indexOf(':');
    if (colonAt < 1) continue;
    const key = line.slice(0, colonAt).trim();
    const rawVal = line.slice(colonAt + 1).trim();
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      meta[key] = rawVal
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    } else {
      meta[key] = rawVal;
    }
  }
  const body = lines.slice(endIdx + 1).join('\n').trimStart();
  return { meta, body };
}

// ---------------------------------------------------------------------------
// Row → SkillMeta helper
// ---------------------------------------------------------------------------

export function rowToMeta(row: Record<string, unknown>): SkillMeta {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    version: row['version'] as number,
    frontmatter: JSON.parse((row['frontmatter_json'] as string) || '{}') as Record<
      string,
      unknown
    >,
    sha256: row['sha256'] as string,
    created_at: row['created_at'] as string,
    archived_at: (row['archived_at'] as string | null) ?? null,
  };
}
