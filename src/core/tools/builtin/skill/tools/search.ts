/**
 * @file search.ts
 * @description skill.search — browse the public SUDO skill registry
 * (sudoapi.shop). Read-only: fetches the registry index and lists matching
 * skills with their capabilities and install hint. Install with skill.install.
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { SkillRegistryClient, isSkillRegistryEnabled } from '../../../../skills/registry-client.js';

const logger = createLogger('skill.search');

export const searchTool: ToolDefinition = {
  name: 'skill.search',
  description:
    'Search/browse the public SUDO skill registry (sudoapi.shop) for installable community skills. '
    + 'Use when asked to "find/browse/search skills", "what skills are available", or before '
    + 'skill.install. Read-only — returns name, version, description, capabilities, and tags. '
    + '(For skills you author yourself, use skill.apply instead.)',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 20_000,
  parameters: {
    query: {
      type: 'string',
      description: 'Substring matched against name, description, and tags. Omit to list everything.',
    },
    tag: {
      type: 'string',
      description: 'Exact tag filter (e.g. "email", "writing").',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!isSkillRegistryEnabled()) {
      return { success: false, output: 'Skill registry is disabled (SUDO_SKILL_REGISTRY=0).' };
    }
    const query = typeof params['query'] === 'string' ? params['query'].trim().toLowerCase() : '';
    const tag = typeof params['tag'] === 'string' ? params['tag'].trim().toLowerCase() : '';
    logger.info({ session: ctx.sessionId, query, tag }, 'skill.search invoked');

    try {
      const client = new SkillRegistryClient();
      const { index, sourceUrl } = await client.fetchIndex();
      const matches = index.skills.filter((s) => {
        if (tag && !(s.tags ?? []).some((t) => t.toLowerCase() === tag)) return false;
        if (!query) return true;
        return (
          s.name.toLowerCase().includes(query)
          || (s.description ?? '').toLowerCase().includes(query)
          || (s.tags ?? []).some((t) => t.toLowerCase().includes(query))
        );
      });
      if (matches.length === 0) {
        return {
          success: true,
          output: `No registry skills match${query ? ` "${query}"` : ''}${tag ? ` (tag: ${tag})` : ''}. Browse https://sudoapi.shop for the full directory.`,
          data: { matches: [], sourceUrl },
        };
      }
      const lines = matches.map((s) =>
        `- ${s.name} v${s.version} — ${s.description ?? '(no description)'} `
        + `[caps: ${(s.capabilities ?? []).join(', ') || 'none'}]${(s.tags ?? []).length ? ` (${(s.tags ?? []).join(', ')})` : ''}`,
      );
      return {
        success: true,
        output:
          `${matches.length} skill(s) in the registry${query || tag ? ' matching your filter' : ''}:\n${lines.join('\n')}\n\n`
          + 'Install one with skill.install { name: "<name>" } (dryRun first, then dryRun: false).',
        data: { matches, sourceUrl },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ session: ctx.sessionId, err: msg }, 'skill.search failed');
      return { success: false, output: `skill.search failed: ${msg}` };
    }
  },
};
