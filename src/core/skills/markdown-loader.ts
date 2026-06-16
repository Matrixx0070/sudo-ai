/**
 * @file markdown-loader.ts
 * @description Loads markdown-based skills from a directory.
 * Each .md file may contain YAML frontmatter (name, description, trigger,
 * allowed-tools) followed by the skill body.  The parsed skills can be
 * injected into system prompts via `skillToSystemPrompt`.
 *
 * Also consumes the agentskills.io directory layout — `<skill>/SKILL.md`
 * (matched case-insensitively, so `skill.md` works too) discovered by a
 * depth-capped, symlink-skipping walk — and parses the standard's canonical
 * frontmatter fields (version, source, trust_tier, caps, tools, provenance).
 * All new fields are optional — existing flat skills still load unchanged.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { SkillTrustTier, ToolTranslatorEntry } from '../shared/wave10-types.js';

const log = createLogger('skills:markdown-loader');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownSkill {
  name: string;
  description: string;
  trigger?: string;
  allowedTools?: string[];
  content: string;
  filePath: string;
  // --- agentskills.io canonical frontmatter (all optional) ---
  /** Semantic version string from frontmatter, e.g. "1.0.0". */
  version?: string;
  /** Source URI, e.g. "github:owner/repo/skill.md". */
  source?: string;
  /** Trust tier declared in frontmatter; validated at import time. */
  trust_tier?: SkillTrustTier;
  /** Capability strings required by this skill, e.g. ["fs.read"]. */
  caps?: string[];
  /** Tool name mappings bundled with this skill. */
  tools?: ToolTranslatorEntry[];
  /** Provenance metadata (author, registry, etc.). */
  provenance?: string;
  // --- Q4: scheduler hints (all optional; undefined = unknown, fall back to serial) ---
  /**
   * True when the skill only reads filesystem / queries / network without
   * mutating state. The workflow scheduler can dispatch read-only skills more
   * aggressively (cache, parallelize, retry without side-effects).
   */
  isReadOnly?: boolean;
  /**
   * True when N concurrent invocations of this skill against the same inputs
   * are safe (no shared mutable state, no rate-limited external API, no
   * order-of-operations requirement). Required by the Phase 1 P3 workflow
   * engine's parallel-pipeline mode.
   */
  isConcurrencySafe?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split('\n')) {
    // Skip indented continuation lines: agentskills.io allows nested maps
    // (e.g. a `metadata:` block) whose inner `key: value` lines would
    // otherwise leak into the top-level meta and clobber real keys.
    if (/^\s/.test(line)) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, ''));
    } else {
      meta[key] = val.replace(/['"]/g, '');
    }
  }
  return { meta, body: match[2] };
}

/**
 * Convert a YAML scalar value into a strict boolean. Accepts "true" / "false"
 * (case-insensitive). Anything else returns undefined, including missing keys —
 * preserves the "unknown" tri-state so the scheduler can fall back to serial.
 */
function parseBool(raw: string | string[] | undefined): boolean | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function parseSkillFile(raw: string, filePath: string, fallbackName: string): MarkdownSkill {
  const { meta, body } = parseFrontmatter(raw);
  // Parse agentskills.io canonical fields (optional, backward-compatible)
  const trustTierRaw = meta['trust_tier'] as string | undefined;
  const validTiers = new Set<string>(['bundled', 'indexed', 'unreviewed', 'workspace']);
  const trust_tier =
    trustTierRaw && validTiers.has(trustTierRaw)
      ? (trustTierRaw as SkillTrustTier)
      : undefined;

  // caps: may be stored as bracket array or comma-separated string
  let caps: string[] | undefined;
  const capsRaw = meta['caps'];
  if (Array.isArray(capsRaw)) {
    caps = capsRaw as string[];
  } else if (typeof capsRaw === 'string' && capsRaw.length > 0) {
    caps = capsRaw.split(',').map((c) => c.trim()).filter(Boolean);
  }

  // tools: JSON-encoded array in frontmatter (optional)
  let tools: ToolTranslatorEntry[] | undefined;
  const toolsRaw = meta['tools'];
  if (typeof toolsRaw === 'string' && toolsRaw.startsWith('[')) {
    try {
      tools = JSON.parse(toolsRaw) as ToolTranslatorEntry[];
    } catch {
      // malformed — skip silently
    }
  }

  return {
    name: (meta.name as string) || fallbackName,
    description: (meta.description as string) || '',
    trigger: meta.trigger as string | undefined,
    allowedTools: Array.isArray(meta['allowed-tools']) ? meta['allowed-tools'] : undefined,
    content: body.trim(),
    filePath,
    // agentskills.io canonical fields
    version: (meta['version'] as string | undefined) || undefined,
    source: (meta['source'] as string | undefined) || undefined,
    trust_tier,
    caps,
    tools,
    provenance: (meta['provenance'] as string | undefined) || undefined,
    // Q4: scheduler hints (camelCase YAML keys)
    isReadOnly: parseBool(meta['isReadOnly']),
    isConcurrencySafe: parseBool(meta['isConcurrencySafe']),
  };
}

/** Depth cap for the agentskills.io directory walk (skills/<category>/<name>/SKILL.md). */
const MAX_WALK_DEPTH = 3;
/** Hard cap on discovered SKILL.md files per root, against pathological trees. */
const MAX_DIR_SKILLS = 500;

/**
 * Walk `dir` looking for files named SKILL.md (case-insensitive, so the
 * agentskills.io canonical `SKILL.md` and this repo's `skill.md` both match).
 * Symlinks are never followed — same security posture as the registry scans.
 */
async function findSkillManifests(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_DIR_SKILLS) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip silently
  }
  for (const entry of entries) {
    if (out.length >= MAX_DIR_SKILLS) return;
    if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
      out.push(path.join(dir, entry.name));
    } else if (entry.isDirectory()) {
      await findSkillManifests(path.join(dir, entry.name), depth + 1, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse the SUDO_SKILLS_DIRS env value (colon-separated extra skill roots,
 * e.g. "~/.claude/skills:/opt/skills") into a clean path list. Single source
 * for both the prompt-path loader and the registry scan in cli.ts.
 */
export function parseSkillRoots(env: string | undefined): string[] {
  return (env ?? '').split(':').map((p) => p.trim()).filter(Boolean);
}

/**
 * Scan `skillsDir` for skills in both supported layouts and return a
 * `MarkdownSkill` array:
 *
 *   1. Flat `.md` files directly in `skillsDir` (legacy layout).
 *   2. agentskills.io directories — `<skill>/SKILL.md` (case-insensitive),
 *      discovered recursively so category folders work
 *      (`skills/<category>/<name>/SKILL.md`).
 *
 * When a directory skill and a flat file declare the same name, the flat
 * file wins (it acts as an explicit local override) and the directory skill
 * is skipped with a debug log.
 *
 * Missing directories are silently ignored; other I/O errors are logged.
 *
 * @param skillsDir - Absolute (or CWD-relative) path to the skills directory.
 */
export async function loadMarkdownSkills(skillsDir: string): Promise<MarkdownSkill[]> {
  const skills: MarkdownSkill[] = [];
  const seen = new Set<string>();
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(skillsDir, entry.name);
      const raw = await readFile(filePath, 'utf-8');
      const skill = parseSkillFile(raw, filePath, entry.name.replace('.md', ''));
      skills.push(skill);
      seen.add(skill.name);
    }

    const manifests: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await findSkillManifests(path.join(skillsDir, entry.name), 1, manifests);
    }
    for (const manifestPath of manifests) {
      try {
        const raw = await readFile(manifestPath, 'utf-8');
        const skill = parseSkillFile(raw, manifestPath, path.basename(path.dirname(manifestPath)));
        if (seen.has(skill.name)) {
          log.debug({ name: skill.name, manifestPath }, 'Directory skill shadowed by flat file — skipped');
          continue;
        }
        skills.push(skill);
        seen.add(skill.name);
      } catch (err) {
        log.warn({ manifestPath, error: (err as Error).message }, 'Failed to load directory skill');
      }
    }
    log.info({ skillCount: skills.length, skillsDir }, 'Loaded markdown skills');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error({ skillsDir, error: (err as Error).message }, 'Error loading skills');
    }
  }
  return skills;
}

/**
 * Convert a `MarkdownSkill` into a system-prompt string.
 * Occurrences of `$ARGUMENTS` in the skill body are replaced with `args`
 * when provided.
 *
 * @param skill - The parsed markdown skill.
 * @param args  - Optional runtime arguments to interpolate into the content.
 */
export function skillToSystemPrompt(skill: MarkdownSkill, args?: string): string {
  let prompt = `# Skill: ${skill.name}\n`;
  if (skill.description) prompt += `${skill.description}\n\n`;
  prompt += skill.content;
  if (args) prompt = prompt.replace(/\$ARGUMENTS/g, args);
  return prompt;
}
