/**
 * @file read.ts
 * @description skill.read — BO6/S3 read-on-demand. Returns the FULL body of an
 * installed skill by name (or path), plus its current version-hash. This is the
 * companion to the always-visible skill catalog in the system prompt
 * (skills/skill-catalog.ts): the catalog tells the model what skills exist and
 * where; when a task matches one, the model calls skill.read to pull the actual
 * instructions on demand instead of the harness force-injecting every body.
 *
 * Read-only by construction: it reads SKILL.md files from the same roots the
 * loader scans (cwd/skills + SUDO_SKILLS_DIRS). It never writes — the skill
 * write-firewall (proposals → skill.apply) is untouched. The returned hash lets
 * a caller detect mid-session edits (if it differs from a catalog entry it
 * cached, the skill changed → re-read).
 */

import path from 'node:path';
import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { PROJECT_ROOT } from '../../../../shared/paths.js';
import { loadMarkdownSkills, parseSkillRoots, type MarkdownSkill } from '../../../../skills/markdown-loader.js';
import { skillHash } from '../../../../skills/skill-catalog.js';

const logger = createLogger('skill.read');

/** Load every installed skill across the loader's roots (cwd/skills + extras). */
async function loadAllSkills(): Promise<MarkdownSkill[]> {
  const roots = [path.join(PROJECT_ROOT, 'skills'), ...parseSkillRoots(process.env['SUDO_SKILLS_DIRS'])];
  const all: MarkdownSkill[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const s of await loadMarkdownSkills(root)) {
      if (seen.has(s.name)) continue; // first root wins (mirrors catalog dedup)
      seen.add(s.name);
      all.push(s);
    }
  }
  return all;
}

export const readTool: ToolDefinition = {
  name: 'skill.read',
  description:
    'Load the FULL instructions of an installed skill on demand. Pass the skill `name` exactly as it '
    + 'appears in the <available_skills> catalog in your system prompt; returns the skill body plus its '
    + 'current version-hash. Use this when a task matches a listed skill and you need its actual steps — '
    + 'do not guess a skill\'s contents from its one-line catalog description. Read-only.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 20_000,
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: 'Skill name as shown in the <available_skills> catalog (e.g. "tldr").',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    if (!name) return { success: false, output: 'A skill `name` is required.' };
    // Names come from the catalog (loader-derived); reject traversal defensively.
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      return { success: false, output: `Invalid skill name "${name}".` };
    }

    try {
      const skills = await loadAllSkills();
      const lc = name.toLowerCase();
      const skill = skills.find((s) => s.name === name) ?? skills.find((s) => s.name.toLowerCase() === lc);
      if (!skill) {
        const available = skills.map((s) => s.name).sort().join(', ');
        return {
          success: false,
          output: `Skill "${name}" is not installed. Available skills: ${available || '(none)'}.`,
        };
      }
      const hash = skillHash(skill.content);
      logger.info({ session: ctx.sessionId, name: skill.name, hash, chars: skill.content.length }, 'skill.read invoked');
      const header = `# Skill: ${skill.name} [${hash}]${skill.description ? `\n${skill.description}` : ''}`;
      return {
        success: true,
        output: `${header}\n\n${skill.content}`,
        data: { name: skill.name, hash, path: skill.filePath, chars: skill.content.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ session: ctx.sessionId, name, err: msg }, 'skill.read failed');
      return { success: false, output: `skill.read failed: ${msg}` };
    }
  },
};
