/**
 * @file skill/tools/compose.ts
 * @description skill.compose — proposes a tool chain to achieve a high-level
 * goal using keyword matching against the ToolRegistry catalog. Does NOT
 * execute the chain — returns a proposal only.
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { ToolRegistry } from '../../../registry.js';

const logger = createLogger('skill:compose');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComposeProposal {
  chain: string[];
  rationale: string;
  estimatedDurationMs: number;
}

// ---------------------------------------------------------------------------
// Keyword → tool scoring
// ---------------------------------------------------------------------------

/**
 * Score a tool for a given goal string.
 * Uses simple keyword matching between goal tokens and tool name + description.
 */
function scoreTool(goal: string, tool: { name: string; description: string }): number {
  const goalTokens = goal.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  let score = 0;
  for (const tok of goalTokens) {
    if (haystack.includes(tok)) score++;
  }
  return score;
}

/** Estimate tool duration in ms based on its name/category heuristics. */
function estimateDuration(toolName: string): number {
  if (toolName.startsWith('browser.')) return 5_000;
  if (toolName.startsWith('media.') || toolName.startsWith('content.')) return 3_000;
  if (toolName.startsWith('data.') || toolName.startsWith('knowledge.')) return 2_000;
  return 1_500;
}

// ---------------------------------------------------------------------------
// Fallback keyword catalog (used when registry is unavailable)
// ---------------------------------------------------------------------------

const FALLBACK_CATALOG: Array<{ name: string; keywords: string[] }> = [
  { name: 'browser.search', keywords: ['search', 'find', 'lookup', 'google', 'web', 'query'] },
  { name: 'browser.navigate', keywords: ['navigate', 'open', 'visit', 'url', 'website', 'page'] },
  { name: 'browser.scrape', keywords: ['scrape', 'extract', 'data', 'website', 'parse', 'html'] },
  { name: 'content.write-script', keywords: ['write', 'script', 'video', 'youtube', 'content', 'create'] },
  { name: 'content.proofread', keywords: ['proofread', 'review', 'edit', 'check', 'grammar', 'quality'] },
  { name: 'media.tts', keywords: ['speak', 'audio', 'tts', 'voice', 'narrate', 'sound'] },
  { name: 'media.record', keywords: ['record', 'video', 'capture', 'film', 'media'] },
  { name: 'data.analyze', keywords: ['analyze', 'analysis', 'data', 'insights', 'report', 'stats'] },
  { name: 'knowledge.search', keywords: ['knowledge', 'information', 'research', 'learn', 'fact'] },
  { name: 'comms.email', keywords: ['email', 'send', 'message', 'notify', 'contact'] },
  { name: 'comms.slack', keywords: ['slack', 'message', 'team', 'notify', 'chat'] },
  { name: 'meta.task-manager', keywords: ['task', 'schedule', 'plan', 'manage', 'todo', 'project'] },
  { name: 'code.run', keywords: ['code', 'run', 'execute', 'script', 'program', 'python'] },
  { name: 'system.shell', keywords: ['shell', 'command', 'terminal', 'bash', 'system', 'os'] },
];

function fallbackCompose(goal: string, maxChainLength: number): ComposeProposal {
  const goalTokens = goal.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const scored = FALLBACK_CATALOG.map(item => {
    let score = 0;
    for (const tok of goalTokens) {
      if (item.keywords.includes(tok) || item.name.includes(tok)) score++;
    }
    return { name: item.name, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  const chain = scored.slice(0, maxChainLength).map(s => s.name);
  const totalMs = chain.reduce((acc, n) => acc + estimateDuration(n), 0);

  return {
    chain,
    rationale: chain.length > 0
      ? `Matched ${chain.length} tools from fallback catalog for goal: "${goal}"`
      : `No tools matched goal "${goal}" — try a more specific description.`,
    estimatedDurationMs: totalMs,
  };
}

// ---------------------------------------------------------------------------
// Registry-based compose
// ---------------------------------------------------------------------------

function registryCompose(
  goal: string,
  maxChainLength: number,
  registry: ToolRegistry,
): ComposeProposal {
  const allTools = registry.listEnabled();

  const scored = allTools
    .map(t => ({ name: t.name, score: scoreTool(goal, t) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Deduplicate by category prefix (avoid 5 browser.* in a row)
  const chain: string[] = [];
  const usedCategories = new Set<string>();

  for (const candidate of scored) {
    if (chain.length >= maxChainLength) break;
    const cat = candidate.name.split('.')[0] ?? '';
    // Allow at most 2 tools per category in the chain
    const catCount = chain.filter(n => n.startsWith(`${cat}.`)).length;
    if (catCount < 2) {
      chain.push(candidate.name);
      usedCategories.add(cat);
    }
  }

  const totalMs = chain.reduce((acc, n) => acc + estimateDuration(n), 0);

  return {
    chain,
    rationale: chain.length > 0
      ? `Proposed ${chain.length}-step chain from ${allTools.length} registered tools for goal: "${goal}"`
      : `No matching tools found for goal "${goal}" in registry (${allTools.length} tools checked).`,
    estimatedDurationMs: totalMs,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const composeTool: ToolDefinition = {
  name: 'skill.compose',
  description:
    'Propose a tool chain to achieve a high-level goal using keyword matching against all registered tools. ' +
    'Returns the proposed chain, rationale, and estimated duration. Does NOT execute the chain.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 15_000,
  parameters: {
    goal: {
      type: 'string',
      required: true,
      description: 'Natural language description of the goal to achieve (e.g. "make a YouTube video about AI news").',
    },
    maxChainLength: {
      type: 'number',
      description: 'Maximum number of tools in the proposed chain (default: 5, max: 10).',
      default: 5,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const goal = params['goal'] as string | undefined;
    const maxChainLength = Math.max(1, Math.min(10, (params['maxChainLength'] as number | undefined) ?? 5));

    logger.info({ session: ctx.sessionId, goal: goal?.slice(0, 80), maxChainLength }, 'skill.compose invoked');

    if (!goal?.trim()) {
      return { success: false, output: 'goal is required.' };
    }

    try {
      const registry = ToolRegistry.getGlobal();
      const proposal = registry
        ? registryCompose(goal, maxChainLength, registry)
        : fallbackCompose(goal, maxChainLength);

      const chainList = proposal.chain.length > 0
        ? proposal.chain.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
        : '  (no tools matched)';

      return {
        success: true,
        output: `Proposed tool chain for: "${goal}"\n${chainList}\n\nRationale: ${proposal.rationale}\nEstimated duration: ${proposal.estimatedDurationMs}ms`,
        data: { proposal },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ goal: goal?.slice(0, 80), err: msg }, 'skill.compose error');
      return { success: false, output: `skill.compose error: ${msg}` };
    }
  },
};
