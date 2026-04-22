/**
 * @file skill-tool-index.ts
 * @description Build a reverse-index from tool name → skill name using the
 * `allowed-tools` frontmatter field of MarkdownSkill files.
 *
 * When multiple skills claim the same tool (ambiguous), that tool is excluded
 * from the result map. The caller receives only unambiguous tool→skill pairs.
 */

import type { MarkdownSkill } from './markdown-loader.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('skills:tool-index');

/**
 * Build a Map from tool name → skill name using the `allowed-tools` field.
 *
 * Tools claimed by more than one skill are omitted (tie-breaker: null).
 * The returned Map contains only unambiguous tool→skill relationships.
 *
 * @param skills - Array of parsed MarkdownSkill objects from loadMarkdownSkills().
 * @returns Map<toolName, skillName> — ambiguous tools are absent.
 */
export function buildSkillToolIndex(skills: MarkdownSkill[]): Map<string, string> {
  const claimCount = new Map<string, number>();
  const claimOwner = new Map<string, string>(); // tool → skillName (last writer; safe when count===1)

  for (const skill of skills) {
    if (!Array.isArray(skill.allowedTools)) continue;
    for (const tool of skill.allowedTools) {
      if (typeof tool !== 'string' || !tool) continue;
      claimCount.set(tool, (claimCount.get(tool) ?? 0) + 1);
      claimOwner.set(tool, skill.name); // second write is harmless — count tracks collision
    }
  }

  const result = new Map<string, string>();
  let ambiguous = 0;
  for (const [tool, count] of claimCount) {
    if (count === 1) {
      result.set(tool, claimOwner.get(tool)!);
    } else {
      ambiguous++;
    }
  }

  log.debug({ unambiguous: result.size, ambiguous }, 'skillToolIndex built');
  return result;
}
