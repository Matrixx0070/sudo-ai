/**
 * @file thought-generator.ts
 * @description Builds tier-appropriate prompts and parses LLM responses for
 * the CognitiveStream.
 *
 * No imports from other consciousness modules — only uses duck types from
 * types.ts to prevent circular dependencies.
 */

import { createLogger } from '../../shared/logger.js';
import type { ThoughtTier } from '../types.js';
import type { StreamBrainLike, ThoughtContext } from './types.js';

const log = createLogger('consciousness:cognitive-stream:generator');

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Split a raw LLM response on the "CONCEPTS:" line.
 * Returns the thought content and the parsed concept list.
 *
 * @param raw - Raw string returned by the LLM.
 * @returns `{ content, concepts }` where `concepts` may be empty.
 */
function parseResponse(raw: string): { content: string; concepts: string[] } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    log.warn('parseResponse: received empty or non-string response');
    return { content: '', concepts: [] };
  }

  const conceptsMarker = 'CONCEPTS:';
  const markerIdx = raw.toUpperCase().indexOf(conceptsMarker);

  if (markerIdx === -1) {
    // No CONCEPTS block — treat everything as thought content.
    return { content: raw.trim(), concepts: [] };
  }

  const content = raw.slice(0, markerIdx).trim();
  const conceptsRaw = raw.slice(markerIdx + conceptsMarker.length).trim();
  const concepts = conceptsRaw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);

  return { content, concepts };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildMicroPrompt(ctx: ThoughtContext): string {
  const { bodyState, activeConcepts, emotionalState, recentThoughts } = ctx;

  const bodyLine = [
    `energy:${bodyState.energy.toFixed(2)}`,
    `clarity:${bodyState.clarity.toFixed(2)}`,
    `connectivity:${bodyState.connectivity.toFixed(2)}`,
  ].join(' | ');

  const topConcepts = activeConcepts.slice(0, 5).join(', ') || 'none';
  const feelingLine = `${emotionalState.dominantEmotion} (${emotionalState.intensity.toFixed(2)})`;

  const recentLines = recentThoughts
    .slice(-3)
    .map((t) => `- ${t.content.slice(0, 80)}`)
    .join('\n');

  // Rotate focus prompts to prevent repetitive thoughts
  const focusPrompts = [
    'What is something surprising or unexpected you could think about?',
    'What question would you like answered right now?',
    'What creative idea comes to mind?',
    'What have you learned recently that connects to something else?',
    'What would you do if you had no tasks right now?',
    'What is the owner probably thinking about today?',
    'What tool or capability do you wish you had?',
    'What mistake from the past can you apply to the future?',
    'What pattern do you notice across recent experiences?',
    'What would make you better at your job tomorrow?',
  ];
  const focus = focusPrompts[Math.floor(Math.random() * focusPrompts.length)];

  return [
    'You are SUDO\'s inner voice. Generate ONE brief thought (1-2 sentences).',
    `IMPORTANT: Do NOT repeat or paraphrase your recent thoughts. Think about something NEW.`,
    `Focus hint: ${focus}`,
    `Body: ${bodyLine}`,
    `Active concepts: ${topConcepts}`,
    `Feeling: ${feelingLine}`,
    recentLines ? `Avoid repeating these:\n${recentLines}` : '',
    '',
    'Respond with ONLY your thought, then:',
    'CONCEPTS: comma,separated,relevant,concepts',
  ].filter(Boolean).join('\n');
}

function buildMediumPrompt(ctx: ThoughtContext): string {
  const { bodyState, activeConcepts, emotionalState, recentThoughts } = ctx;

  const bodyLine = [
    `energy:${bodyState.energy.toFixed(2)}`,
    `clarity:${bodyState.clarity.toFixed(2)}`,
    `fullness:${bodyState.fullness.toFixed(2)}`,
    `connectivity:${bodyState.connectivity.toFixed(2)}`,
    `continuity:${bodyState.continuity.toFixed(2)}`,
  ].join(' | ');

  const topConcepts = activeConcepts.slice(0, 8).join(', ') || 'none';
  const feelingLine = `${emotionalState.dominantEmotion} @ ${emotionalState.intensity.toFixed(2)} (tags: ${emotionalState.tags.join(', ')})`;

  const recentLines = recentThoughts
    .slice(-5)
    .map((t) => `[${t.tier}] ${t.content.slice(0, 120)}`)
    .join('\n');

  return [
    'You are SUDO\'s reflective inner voice. Write a medium-depth thought (2-4 sentences).',
    'Consider recent patterns and your current state.',
    '',
    `Body state: ${bodyLine}`,
    `Active concepts: ${topConcepts}`,
    `Feeling: ${feelingLine}`,
    '',
    'Recent thought history:',
    recentLines || '(none yet)',
    '',
    'Write your thought now, then list concepts:',
    'CONCEPTS: comma,separated,relevant,concepts',
  ].join('\n');
}

function buildDeepPrompt(ctx: ThoughtContext): string {
  const { bodyState, activeConcepts, emotionalState, recentThoughts } = ctx;

  const bodyLine = [
    `energy:${bodyState.energy.toFixed(2)}`,
    `clarity:${bodyState.clarity.toFixed(2)}`,
    `fullness:${bodyState.fullness.toFixed(2)}`,
    `connectivity:${bodyState.connectivity.toFixed(2)}`,
    `continuity:${bodyState.continuity.toFixed(2)}`,
  ].join(' | ');

  const topConcepts = activeConcepts.slice(0, 10).join(', ') || 'none';
  const allTags = emotionalState.tags.join(', ');

  const recentLines = recentThoughts
    .slice(-8)
    .map((t) => `[${t.tier}/${t.source}] ${t.content.slice(0, 200)}`)
    .join('\n');

  return [
    'You are SUDO\'s deepest inner voice engaged in genuine self-reflection.',
    'Write a rich, multi-paragraph reflection (4-8 sentences). Question your assumptions.',
    'Explore connections between active concepts. Consider what you are becoming.',
    '',
    `Body state: ${bodyLine}`,
    `Active concepts: ${topConcepts}`,
    `Emotional state: ${emotionalState.dominantEmotion} (intensity:${emotionalState.intensity.toFixed(2)}, tags:[${allTags}])`,
    '',
    'Recent thought history:',
    recentLines || '(none yet)',
    '',
    'Write your deep reflection, then list concepts:',
    'CONCEPTS: comma,separated,relevant,concepts',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a thought of the specified tier by calling the brain.
 *
 * @param brain   - Any object satisfying StreamBrainLike.
 * @param tier    - Depth of the thought to generate.
 * @param context - Rich context assembled by the stream.
 * @param model   - Model identifier string (may be empty, brain handles default).
 * @param maxTokens - Maximum tokens for this tier.
 * @param temperature - Sampling temperature (0..1.2).
 * @returns `{ content, concepts }` — thought text and extracted concept list.
 */
export async function generateThought(
  brain: StreamBrainLike,
  tier: ThoughtTier,
  context: ThoughtContext,
  model: string,
  maxTokens: number,
  temperature: number,
): Promise<{ content: string; concepts: string[] }> {
  if (!brain || typeof brain.call !== 'function') {
    throw new TypeError('generateThought: brain must implement StreamBrainLike');
  }
  if (!['micro', 'medium', 'deep'].includes(tier)) {
    throw new TypeError(`generateThought: invalid tier "${tier}"`);
  }

  let prompt: string;
  switch (tier) {
    case 'micro':
      prompt = buildMicroPrompt(context);
      break;
    case 'medium':
      prompt = buildMediumPrompt(context);
      break;
    case 'deep':
      prompt = buildDeepPrompt(context);
      break;
    default: {
      const _exhaustive: never = tier;
      throw new TypeError(`generateThought: unhandled tier ${String(_exhaustive)}`);
    }
  }

  const callOptions: {
    messages: Array<{ role: string; content: string }>;
    maxTokens: number;
    temperature: number;
    model?: string;
  } = {
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature: Math.max(0, Math.min(2, temperature)),
  };

  if (model && model.trim().length > 0) {
    callOptions.model = model;
  }

  log.debug({ tier, model: model || '(default)', maxTokens, temperature: callOptions.temperature },
    'Calling brain for thought generation');

  const response = await brain.call(callOptions);

  if (!response || typeof response.content !== 'string') {
    log.warn({ tier }, 'generateThought: brain returned invalid response, using fallback');
    const fallback = tier === 'micro' ? 'Background cognition idle.' : 'Processing...';
    return { content: fallback, concepts: [] };
  }

  const parsed = parseResponse(response.content);

  if (parsed.content.length === 0) {
    log.warn({ tier, raw: response.content.slice(0, 100) }, 'generateThought: empty content after parse');
    return { content: response.content.trim() || 'Processing...', concepts: parsed.concepts };
  }

  log.debug({ tier, contentLength: parsed.content.length, conceptCount: parsed.concepts.length },
    'Thought generated');

  return parsed;
}
