/**
 * @file skill/tools/explain.ts
 * @description skill.explain — emits a rich markdown explanation block for a
 * given tool by combining ToolRegistry metadata with live usage stats from
 * skill.usage-stats. Returns the markdown as a string.
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { ToolRegistry } from '../../../registry.js';
import { getUsageStats } from './usage-stats.js';

const logger = createLogger('skill:explain');

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

function buildMarkdown(
  toolName: string,
  description: string,
  params: string,
  totalCalls: number,
  successRate: number,
  commonFailures: string[],
  windowDays: number,
): string {
  const failureSection = commonFailures.length > 0
    ? commonFailures.map(f => `- ${f}`).join('\n')
    : '- None recorded';

  return [
    `## ${toolName}`,
    '',
    `**Description:** ${description}`,
    '',
    `**Parameters:**`,
    params,
    '',
    `**Usage (last ${windowDays}d):** ${totalCalls} call${totalCalls !== 1 ? 's' : ''}, ${(successRate * 100).toFixed(1)}% success`,
    '',
    `**Common failures:**`,
    failureSection,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const explainTool: ToolDefinition = {
  name: 'skill.explain',
  description:
    'Emit a rich markdown explanation for any registered tool, combining its schema metadata with live usage statistics. Returns a formatted SKILL.md-style markdown block.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 15_000,
  parameters: {
    toolName: {
      type: 'string',
      required: true,
      description: 'Dot-namespaced tool name to explain (e.g. "browser.navigate").',
    },
    windowDays: {
      type: 'number',
      description: 'Look-back window for usage stats in days (default: 7).',
      default: 7,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const toolName = params['toolName'] as string | undefined;
    const windowDays = Math.max(1, Math.min(365, (params['windowDays'] as number | undefined) ?? 7));

    logger.info({ session: ctx.sessionId, toolName, windowDays }, 'skill.explain invoked');

    if (!toolName?.trim()) {
      return { success: false, output: 'toolName is required.' };
    }

    try {
      // 1. Retrieve tool metadata from registry
      const registry = ToolRegistry.getGlobal();
      const toolDef = registry?.get(toolName);

      const description = toolDef?.description ?? '(Tool not found in active registry)';
      const paramEntries = toolDef?.parameters
        ? Object.entries(toolDef.parameters).map(
            ([key, p]) =>
              `- \`${key}\` (${p.type}${p.required ? ', required' : ''}): ${p.description}`
          )
        : ['- (no parameter info available)'];
      const paramsBlock = paramEntries.join('\n');

      // 2. Retrieve usage stats
      let totalCalls = 0;
      let successRate = 0;
      let commonFailures: string[] = [];

      try {
        const stats = await getUsageStats(toolName, windowDays);
        const stat = stats.find(s => s.toolName === toolName) ?? stats[0];
        if (stat) {
          totalCalls = stat.totalCalls;
          successRate = stat.successRate;
          commonFailures = stat.topErrorKinds.slice(0, 5);
        }
      } catch (statErr) {
        logger.warn({ toolName, err: String(statErr) }, 'skill.explain: usage stats unavailable');
      }

      // 3. Build markdown
      const markdown = buildMarkdown(
        toolName,
        description,
        paramsBlock,
        totalCalls,
        successRate,
        commonFailures,
        windowDays,
      );

      return {
        success: true,
        output: markdown,
        data: {
          toolName,
          found: !!toolDef,
          totalCalls,
          successRate,
          windowDays,
          markdown,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ toolName, err: msg }, 'skill.explain error');
      return { success: false, output: `skill.explain error: ${msg}` };
    }
  },
};
