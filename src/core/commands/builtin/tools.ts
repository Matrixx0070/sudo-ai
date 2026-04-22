/**
 * @file builtin/tools.ts
 * @description /tools — lists all registered tools grouped by category with counts.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:tools');

interface ToolInfo {
  name: string;
  category: string;
  description: string;
}

export const toolsCommand: SlashCommand = {
  name: 'tools',
  description: 'List all registered tools by category with counts.',
  usage: '/tools',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId }, '/tools executed');

    const registry = ctx.toolRegistry as {
      listAll?: () => ToolInfo[];
      size?: number;
      enabledSize?: number;
    } | null;

    const all: ToolInfo[] = registry?.listAll?.() ?? [];

    if (all.length === 0) {
      return 'No tools registered.';
    }

    // Group by category
    const byCategory = new Map<string, ToolInfo[]>();
    for (const tool of all) {
      const cat = tool.category ?? 'uncategorized';
      const group = byCategory.get(cat) ?? [];
      group.push(tool);
      byCategory.set(cat, group);
    }

    const lines: string[] = [
      `Tools: ${registry?.enabledSize ?? all.length} enabled / ${registry?.size ?? all.length} total`,
      '',
    ];

    const sortedCats = [...byCategory.keys()].sort();
    for (const cat of sortedCats) {
      const group = byCategory.get(cat)!;
      lines.push(`[${cat.toUpperCase()}] (${group.length})`);
      for (const t of group.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`  ${t.name}`);
      }
    }

    return lines.join('\n');
  },
};
