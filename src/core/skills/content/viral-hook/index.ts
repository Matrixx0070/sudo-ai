/**
 * Skill: content.viral-hook
 * Category: content
 * Version: 1.0.0
 *
 * Generates viral hooks for YouTube Shorts using proven patterns from the owner's
 * content strategy (target audience, curiosity/shock/challenge styles).
 *
 * Pattern library is hard-coded from feedback_content_strategy and the owner's
 * known high-performing formulas. No LLM call — deterministic fast output.
 * The agent can further refine these hooks with LLM calls if desired.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../tools/types.js';
import type { ToolRegistry } from '../../../tools/registry.js';

const logger = createLogger('skill.content.viral-hook');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookStyle = 'curiosity' | 'shock' | 'challenge';

export interface ViralHookInput {
  topic: string;
  style: HookStyle;
}

export interface ViralHookOutput {
  hooks: string[];
  recommended: string;
}

// ---------------------------------------------------------------------------
// Pattern library
// ---------------------------------------------------------------------------
// Each template has a {topic} placeholder. Capital letters signal emphasis.

const PATTERNS: Record<HookStyle, string[]> = {
  curiosity: [
    'What happens when {topic}? (You won\'t believe this)',
    'Nobody talks about this: {topic} explained in 60 seconds',
    'The hidden truth about {topic} that experts don\'t want you to know',
    'I tried {topic} for 30 days — here\'s what actually happened',
    'Why {topic} is completely different than you think',
    'This single fact about {topic} will change how you see everything',
    'Scientists just discovered something shocking about {topic}',
    'The reason {topic} works will SURPRISE you',
  ],
  shock: [
    'WAIT — {topic} is actually ILLEGAL in 7 countries 😱',
    '{topic} just changed FOREVER and nobody noticed',
    'This is the REAL reason {topic} exists (it\'s not what you think)',
    'BREAKING: {topic} has been lying to you this whole time',
    'They deleted this video about {topic} — watch before it\'s gone',
    '{topic} costs MORE than your salary. Here\'s proof.',
    'I spent $10,000 on {topic} so you don\'t have to',
    'WARNING: {topic} is more dangerous than people admit',
  ],
  challenge: [
    'Can YOU pass the {topic} test? 99% fail',
    'I challenge you to watch this {topic} video without pausing',
    'Try explaining {topic} in 10 seconds — bet you can\'t',
    'Only 1% of people know this about {topic} — are you one of them?',
    'Watch this {topic} clip and then tell me you\'re not shocked',
    'Name ONE person who doesn\'t relate to {topic}. I\'ll wait.',
    'This {topic} challenge broke the internet in India',
    'POV: You finally understand {topic} (everyone\'s reaction)',
  ],
};

/** Audience-specific power words for the configured region */
const POWER_WORDS_IND = ['yaar', 'bhai', 'desi', 'jugaad', 'jaldi', 'asli', 'sach'];
const EMOJIS_BY_STYLE: Record<HookStyle, string[]> = {
  curiosity: ['🤔', '💡', '🧠', '👀', '🔍'],
  shock:     ['😱', '🚨', '💥', '⚡', '🔥'],
  challenge: ['💪', '🏆', '🎯', '🤯', '👊'],
};

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function generateHooks(input: ViralHookInput): ViralHookOutput {
  const { topic, style } = input;
  const templates = PATTERNS[style];
  const emojis = EMOJIS_BY_STYLE[style];

  // Generate base hooks by filling the template
  const hooks: string[] = templates.map((tmpl, idx) => {
    let hook = tmpl.replace(/\{topic\}/g, topic);
    // Append a random emoji for engagement (deterministic based on index)
    hook += ' ' + (emojis[idx % emojis.length] ?? '');
    return hook;
  });

  // Add 2 localised variants mixing a power word
  const localWord = POWER_WORDS_IND[hooks.length % POWER_WORDS_IND.length] ?? 'yaar';
  hooks.push(`${localWord.toUpperCase()! } — ${topic} ne mera dimaag hilaa diya! ${emojis[0] ?? ''}`);
  hooks.push(`Sach bol: kya tu sach mein ${topic} ke baare mein jaanta hai? ${emojis[1] ?? ''}`);

  // Recommended hook: shortest curiosity hook scores well for sub-15s shorts
  const sortedByLength = [...hooks].sort((a, b) => a.length - b.length);
  const recommended = sortedByLength[0] ?? hooks[0] ?? '';

  return { hooks, recommended };
}

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

export const skillTool: ToolDefinition = {
  name: 'content.viral-hook',
  description:
    'Generate viral hook lines for YouTube Shorts on any topic. '
    + 'Supports three styles: curiosity, shock, and challenge. '
    + 'Returns a list of hooks plus a recommended pick. '
    + 'Input: { topic, style }. Output: { hooks, recommended }.',
  category: 'content',
  timeout: 5_000,
  parameters: {
    topic: {
      type: 'string',
      required: true,
      description: 'The subject of the YouTube Short (e.g. "ChatGPT", "crypto crash", "Elon Musk").',
    },
    style: {
      type: 'string',
      required: true,
      enum: ['curiosity', 'shock', 'challenge'],
      description: 'Hook style: curiosity (makes viewer want to know more), shock (surprising/controversial), challenge (dares viewer).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = params['topic'];
    const style = params['style'] as HookStyle | undefined;

    if (typeof topic !== 'string' || !topic.trim()) {
      return { success: false, output: 'content.viral-hook: topic is required.' };
    }
    if (!style || !['curiosity', 'shock', 'challenge'].includes(style)) {
      return { success: false, output: 'content.viral-hook: style must be one of: curiosity, shock, challenge.' };
    }

    logger.info({ session: ctx.sessionId, topic, style }, 'content.viral-hook generating hooks');

    try {
      const result = generateHooks({ topic: topic.trim(), style });
      return {
        success: true,
        output: [
          `Generated ${result.hooks.length} ${style} hooks for "${topic}":`,
          ...result.hooks.map((h, i) => `  ${i + 1}. ${h}`),
          '',
          `Recommended: ${result.recommended}`,
        ].join('\n'),
        data: result,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, style, err: msg }, 'content.viral-hook error');
      return { success: false, output: `content.viral-hook error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration export
// ---------------------------------------------------------------------------

export function registerSkill(registry: ToolRegistry): void {
  registry.register(skillTool);
}

export default skillTool;
