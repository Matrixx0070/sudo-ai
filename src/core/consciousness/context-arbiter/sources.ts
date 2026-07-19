/**
 * @file sources.ts
 * @description CW4 — bid construction from REAL consciousness state. Input is
 * the getIntelligenceBriefContext(message) result the loop already obtains per
 * turn (no extra module calls, zero LLM calls). Six starting sources per the
 * handoff CW4; values/confidences are real signals:
 *
 *  surprise      value = surpriseLevel (avg magnitude 0..1, honest post-CW1)
 *  drive         value = dominantDrive.intensity (honest post-CW1)
 *  episodic      value = max episode significance; confidence scales w/ hit count
 *  emotion       value = emotionalState.intensity
 *  metacognition value = reflection presence-scaled; confidence = selfCompetence.overallConfidence
 *  procedure     value = matchingProcedure.successRate (empirical)
 */

import type { ContextBid } from './types.js';

/** Shape subset of getIntelligenceBriefContext's return we bid from. */
export interface BriefContextLike {
  dominantDrive: { name: string; intensity: number; satisfiedBy?: string } | null;
  emotionalState: { emotion: string; intensity: number } | null;
  matchingProcedure: { name: string; steps: string[]; successRate: number } | null;
  recentEpisodes: Array<{ summary: string; outcome: string; significance: number; timestamp: string }>;
  metacognitiveReflections: Array<{ conclusion: string; actionItem: string }>;
  surpriseLevel: number;
  selfCompetence: { overallConfidence: number } | null;
}

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

function bid(source: string, content: string, value: number, confidence: number): ContextBid {
  return { source, content, value, confidence, tokenCost: estimateTokens(content) };
}

const clamp = (n: number): number => Math.max(0, Math.min(1, n));

/** Build bids from real state. Sources with no signal return no bid. */
export function collectBids(ctx: BriefContextLike): ContextBid[] {
  const bids: ContextBid[] = [];

  if (ctx.surpriseLevel > 0) {
    bids.push(bid(
      'surprise',
      `Recent surprise level: ${ctx.surpriseLevel.toFixed(2)} — predictions have been ${ctx.surpriseLevel > 0.5 ? 'unreliable; verify assumptions' : 'mostly holding'}.`,
      clamp(ctx.surpriseLevel),
      0.9, // direct store aggregate — high confidence
    ));
  }

  if (ctx.dominantDrive) {
    const d = ctx.dominantDrive;
    bids.push(bid(
      'drive',
      `Dominant drive: ${d.name} (intensity ${d.intensity.toFixed(2)})${d.satisfiedBy ? ` — satisfied by ${d.satisfiedBy}` : ''}.`,
      clamp(d.intensity),
      0.8, // computed from real signals post-CW1
    ));
  }

  if (ctx.recentEpisodes.length > 0) {
    const maxSig = Math.max(...ctx.recentEpisodes.map((e) => e.significance ?? 0));
    const lines = ctx.recentEpisodes.map((e) => `- ${e.summary} (${e.outcome})`).join('\n');
    bids.push(bid(
      'episodic',
      `Relevant past episodes:\n${lines}`,
      clamp(maxSig),
      clamp(0.5 + 0.1 * ctx.recentEpisodes.length), // recall-rank proxy: more hits -> more confidence
    ));
  }

  if (ctx.emotionalState && ctx.emotionalState.intensity > 0) {
    bids.push(bid(
      'emotion',
      `Current feeling: ${ctx.emotionalState.emotion} (intensity ${ctx.emotionalState.intensity.toFixed(2)}).`,
      clamp(ctx.emotionalState.intensity),
      0.7,
    ));
  }

  if (ctx.metacognitiveReflections.length > 0) {
    const lines = ctx.metacognitiveReflections
      .map((r) => `- ${r.conclusion}${r.actionItem ? ` -> ${r.actionItem}` : ''}`)
      .join('\n');
    bids.push(bid(
      'metacognition',
      `Metacognitive reflections:\n${lines}`,
      clamp(0.4 + 0.15 * ctx.metacognitiveReflections.length),
      clamp(ctx.selfCompetence?.overallConfidence ?? 0.5),
    ));
  }

  if (ctx.matchingProcedure) {
    const p = ctx.matchingProcedure;
    bids.push(bid(
      'procedure',
      `Known procedure "${p.name}" matches (success rate ${(p.successRate * 100).toFixed(0)}%): ${p.steps.filter(Boolean).join(' -> ')}.`,
      clamp(p.successRate),
      clamp(p.successRate), // empirical success rate serves as both value and confidence
    ));
  }

  return bids;
}
