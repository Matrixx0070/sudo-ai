/**
 * @file markdown-loader.ts
 * @description Loads markdown-based skills from a directory.
 * Each .md file may contain YAML frontmatter (name, description, trigger,
 * allowed-tools) followed by the skill body.  The parsed skills can be
 * injected into system prompts via `skillToSystemPrompt`.
 *
 * Wave 10 extension: now also parses agentskills.io canonical frontmatter
 * fields (version, source, trust_tier, caps, tools, provenance).
 * All new fields are optional — existing 33 skills still load unchanged.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SkillTrustTier, ToolTranslatorEntry } from '../shared/wave10-types.js';

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
  // --- Wave 10: agentskills.io canonical frontmatter (all optional) ---
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string | string[]> = {};
  for (const line of match[1].split('\n')) {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `skillsDir` for `.md` files, parse their frontmatter, and return a
 * `MarkdownSkill` array.  Missing directories are silently ignored; other
 * I/O errors are logged to stderr.
 *
 * @param skillsDir - Absolute (or CWD-relative) path to the skills directory.
 */
export async function loadMarkdownSkills(skillsDir: string): Promise<MarkdownSkill[]> {
  const skills: MarkdownSkill[] = [];
  try {
    const files = await readdir(skillsDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(skillsDir, file);
      const raw = await readFile(filePath, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      // Parse Wave 10 canonical fields (optional, backward-compatible)
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

      skills.push({
        name: (meta.name as string) || file.replace('.md', ''),
        description: (meta.description as string) || '',
        trigger: meta.trigger as string | undefined,
        allowedTools: Array.isArray(meta['allowed-tools']) ? meta['allowed-tools'] : undefined,
        content: body.trim(),
        filePath,
        // Wave 10 canonical fields
        version: (meta['version'] as string | undefined) || undefined,
        source: (meta['source'] as string | undefined) || undefined,
        trust_tier,
        caps,
        tools,
        provenance: (meta['provenance'] as string | undefined) || undefined,
      });
    }
    console.log(`[skills] Loaded ${skills.length} markdown skills from ${skillsDir}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[skills] Error loading skills from ${skillsDir}:`, (err as Error).message);
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
