/**
 * @file debate.ts
 * @description Core debate execution logic for the internal-dialogue module.
 *
 * A single LLM call produces four labelled voice perspectives.
 * Each perspective is parsed, weighted, and voted on to produce a resolution.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import { genId } from '../../shared/utils.js';
import { getWeightsForContext } from './voices.js';
import type { Debate, DialogueBrainLike, VoicePosition, VoiceName } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('internal-dialogue:debate');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ordered voice labels as they appear in the LLM prompt and response. */
const VOICE_LABELS: ReadonlyArray<{ name: VoiceName; label: string }> = [
  { name: 'analyst',    label: 'ANALYST' },
  { name: 'creative',   label: 'CREATIVE' },
  { name: 'skeptic',    label: 'SKEPTIC' },
  { name: 'strategist', label: 'STRATEGIST' },
];

const DEFAULT_CONFIDENCE = 0.5;
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.7;
const CONFIDENCE_REGEX = /CONFIDENCE:\s*([\d.]+)/i;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(question: string, context: string): string {
  return `You are debating internally. For the question: "${question}"
Context: ${context}
Give FOUR perspectives, one per voice:
ANALYST: [data-driven position, 2-3 sentences]
CREATIVE: [innovative position, 2-3 sentences]
SKEPTIC: [critical position, 2-3 sentences]
STRATEGIST: [long-term position, 2-3 sentences]
For each, end with CONFIDENCE: X.X (0-1)`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Extract the text block belonging to a single voice from the full LLM response.
 *
 * Splits the response at each voice label boundary and takes the segment that
 * follows the target label up until the next label (or end of string).
 */
function extractVoiceBlock(response: string, label: string, nextLabel?: string): string {
  const startMarker = `${label}:`;
  const startIdx = response.indexOf(startMarker);
  if (startIdx === -1) return '';

  const contentStart = startIdx + startMarker.length;

  if (nextLabel) {
    const endIdx = response.indexOf(`${nextLabel}:`, contentStart);
    return endIdx !== -1
      ? response.slice(contentStart, endIdx).trim()
      : response.slice(contentStart).trim();
  }

  return response.slice(contentStart).trim();
}

/**
 * Parse a confidence value from a voice text block.
 * Returns DEFAULT_CONFIDENCE if the pattern is absent or the value is out of range.
 */
function parseConfidence(block: string): number {
  const match = CONFIDENCE_REGEX.exec(block);
  if (!match) return DEFAULT_CONFIDENCE;

  const value = parseFloat(match[1] as string);
  if (Number.isNaN(value) || value < 0 || value > 1) return DEFAULT_CONFIDENCE;
  return value;
}

/**
 * Strip the trailing CONFIDENCE line from a position block so that only the
 * natural-language content is stored.
 */
function stripConfidenceLine(block: string): string {
  return block.replace(/\n?CONFIDENCE:\s*[\d.]+/i, '').trim();
}

/**
 * Parse all four voice positions from the raw LLM response string.
 * Any missing voice defaults to an empty position with DEFAULT_CONFIDENCE.
 */
function parsePositions(response: string): VoicePosition[] {
  return VOICE_LABELS.map(({ name, label }, idx) => {
    const nextLabel = VOICE_LABELS[idx + 1]?.label;
    const block = extractVoiceBlock(response, label, nextLabel);

    const confidence = parseConfidence(block);
    const positionText = stripConfidenceLine(block);

    if (!positionText) {
      log.warn({ voice: name }, 'debate: no position text found for voice — using empty string');
    }

    return {
      voice: name,
      position: positionText,
      confidence,
      reasoning: positionText,  // Reasoning and position are the same raw block.
    } satisfies VoicePosition;
  });
}

// ---------------------------------------------------------------------------
// Weighted vote
// ---------------------------------------------------------------------------

interface VoteResult {
  winningVoice: VoiceName;
  winningScore: number;
  totalScore: number;
}

/**
 * Apply context-type weights to confidence scores and pick the winning voice.
 *
 * @param positions   - Parsed voice positions with individual confidences.
 * @param contextType - Context type string used to look up weights.
 * @returns The winning voice, its raw score, and the sum of all scores.
 */
function weightedVote(positions: VoicePosition[], contextType: string): VoteResult {
  const weights = getWeightsForContext(contextType);

  let winningVoice: VoiceName = 'analyst';
  let winningScore = -1;
  let totalScore = 0;

  for (const pos of positions) {
    const weight = weights[pos.voice];
    const score = pos.confidence * weight;
    totalScore += score;

    if (score > winningScore) {
      winningScore = score;
      winningVoice = pos.voice;
    }
  }

  return { winningVoice, winningScore, totalScore };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full four-voice internal debate via a single LLM call.
 *
 * @param brain       - LLM brain instance implementing DialogueBrainLike.
 * @param question    - The decision or question to debate.
 * @param context     - Surrounding context for the debate.
 * @param contextType - Type of context; drives voice weight selection.
 * @returns A completed Debate object ready for persistence.
 * @throws ConsciousnessError on LLM failure or empty response.
 */
export async function runDebate(
  brain: DialogueBrainLike,
  question: string,
  context: string,
  contextType: string,
): Promise<Debate> {
  if (!question || typeof question !== 'string' || question.trim() === '') {
    throw new ConsciousnessError(
      'runDebate: question must be a non-empty string',
      'consciousness_invalid_debate_question',
      { question },
    );
  }
  if (!context || typeof context !== 'string') {
    throw new ConsciousnessError(
      'runDebate: context must be a non-empty string',
      'consciousness_invalid_debate_context',
      { context },
    );
  }

  const prompt = buildPrompt(question.trim(), context.trim());
  log.debug({ contextType, questionSnippet: question.slice(0, 80) }, 'debate: calling LLM');

  let response: string;
  try {
    const result = await brain.call({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });
    response = result.content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `runDebate: LLM call failed — ${msg}`,
      'consciousness_debate_llm_failed',
      { error: msg },
    );
  }

  if (!response || response.trim() === '') {
    throw new ConsciousnessError(
      'runDebate: LLM returned empty response',
      'consciousness_debate_empty_response',
      {},
    );
  }

  const positions = parsePositions(response);
  const { winningVoice, winningScore, totalScore } = weightedVote(positions, contextType);

  const winningPosition = positions.find((p) => p.voice === winningVoice);
  const resolution = winningPosition?.position ?? '';

  // Normalised confidence: winner's score as a fraction of total weighted vote.
  const normalised = totalScore > 0 ? winningScore / totalScore : DEFAULT_CONFIDENCE;

  const debate: Debate = {
    id: genId(),
    question: question.trim(),
    context: context.trim(),
    positions,
    resolution,
    winningVoice,
    confidence: Math.min(1, Math.max(0, normalised)),
    contextType: contextType || 'general',
    createdAt: new Date().toISOString(),
  };

  log.info(
    { id: debate.id, winningVoice, confidence: debate.confidence.toFixed(3), contextType },
    'debate: completed',
  );

  return debate;
}
