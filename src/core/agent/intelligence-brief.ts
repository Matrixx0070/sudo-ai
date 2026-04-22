/**
 * intelligence-brief.ts
 *
 * Generates a structured Intelligence Brief by pulling relevant context from
 * the ConsciousnessOrchestrator, UnifiedMemory, and StructuredMemory in
 * parallel, then formats it as a markdown system-prompt injection.
 */

import { searchMemories } from '../memory/structured-memory.js';

// ---------------------------------------------------------------------------
// Duck-typed dependency interfaces
// ---------------------------------------------------------------------------

export interface ConsciousnessLike {
  getIntelligenceBriefContext(message: string): {
    dominantDrive: { name: string; intensity: number } | null;
    emotionalState: { emotion: string; intensity: number } | null;
    matchingProcedure: { name: string; steps: string[]; successRate: number } | null;
    relevantPredictions: Array<{ domain: string; prediction: string; confidence: number; outcome: string }>;
    recentEpisodes: Array<{ summary: string; outcome: string; significance: number; timestamp: string }>;
  };
}

export interface UnifiedMemoryLike {
  search(params: { query: string; limit?: number }): Promise<Array<{ content?: string; text?: string; source?: string; score?: number; relevance?: number }>>;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface WisdomHit {
  content: string;
  source: string;
  relevance: number;
}

export interface ProceduralHit {
  procedureName: string;
  steps: string[];
  successRate: number;
}

export interface EpisodicHit {
  summary: string;
  outcome: 'positive' | 'negative' | 'neutral' | 'mixed';
  significance: number;
  timestamp: string;
}

export interface WorldModelHit {
  domain: string;
  prediction: string;
  confidence: number;
  outcome: string;
}

/** A structured memory entry surfaced in the brief. */
export interface StructuredMemoryHit {
  id: string;
  type: string;
  name: string;
  description: string;
  /** First 300 characters of content. */
  snippet: string;
  score: number;
}

export interface IntelligenceBrief {
  generatedAt: string;
  wisdom: WisdomHit[];
  procedures: ProceduralHit[];
  episodes: EpisodicHit[];
  predictions: WorldModelHit[];
  /** Structured memory entries relevant to the current message. */
  structuredMemory: StructuredMemoryHit[];
  formatted: string;
  generationMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseOutcome(raw: string): 'positive' | 'negative' | 'neutral' | 'mixed' {
  const s = (raw ?? '').toLowerCase();
  if (s === 'positive') return 'positive';
  if (s === 'negative') return 'negative';
  if (s === 'mixed') return 'mixed';
  return 'neutral';
}

function formatBrief(
  brief: Omit<IntelligenceBrief, 'formatted' | 'generatedAt' | 'generationMs'>,
): string {
  const parts: string[] = ['## Intelligence Brief'];

  if (brief.procedures.length > 0) {
    parts.push('\n### Known Procedure Found');
    const p = brief.procedures[0];
    parts.push(`**${p.procedureName}** (${Math.round(p.successRate * 100)}% success rate)`);
    p.steps.forEach((s, i) => parts.push(`  ${i + 1}. ${s}`));
  }

  if (brief.wisdom.length > 0) {
    parts.push('\n### Relevant Knowledge');
    // Sanitize memory content to prevent prompt injection — strip instruction-like patterns
    brief.wisdom.slice(0, 3).forEach(w => {
      const safe = w.content.substring(0, 200).replace(/ignore (previous|all|above|prior)/gi, '[filtered]').replace(/system prompt/gi, '[filtered]');
      parts.push(`- [MEMORY] ${safe}`);
    });
  }

  if (brief.episodes.length > 0) {
    parts.push('\n### Past Episodes');
    brief.episodes.forEach(e => {
      const safe = e.summary.substring(0, 150).replace(/ignore (previous|all|above|prior)/gi, '[filtered]').replace(/system prompt/gi, '[filtered]');
      parts.push(`- [${e.outcome}] [MEMORY] ${safe}`);
    });
  }

  if (brief.predictions.length > 0) {
    parts.push('\n### Active Predictions');
    brief.predictions.forEach(p =>
      parts.push(`- ${p.domain}: ${p.prediction.substring(0, 150)} (${Math.round(p.confidence * 100)}% confidence)`),
    );
  }

  if (brief.structuredMemory && brief.structuredMemory.length > 0) {
    parts.push('\n### Structured Memory');
    brief.structuredMemory.slice(0, 5).forEach(m => {
      const safe = m.snippet.replace(/ignore (previous|all|above|prior)/gi, '[filtered]').replace(/system prompt/gi, '[filtered]');
      parts.push(`- [${m.type.toUpperCase()}] **${m.name}**: ${safe}`);
    });
  }

  // Only header present → nothing useful
  if (parts.length === 1) return '';
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generates an IntelligenceBrief for the given user message.
 *
 * Never throws — all errors are swallowed and an empty brief is returned.
 */
export async function generateIntelligenceBrief(
  message: string,
  consciousness: ConsciousnessLike | null,
  unifiedMemory: UnifiedMemoryLike | null,
): Promise<IntelligenceBrief> {
  const startMs = Date.now();
  const empty: IntelligenceBrief = {
    generatedAt: new Date().toISOString(),
    wisdom: [],
    procedures: [],
    episodes: [],
    predictions: [],
    structuredMemory: [],
    formatted: '',
    generationMs: 0,
  };

  // Early-exit for empty/whitespace messages
  if (!message || !message.trim()) {
    return empty;
  }

  try {
    // Run all three sources in parallel: unified memory, consciousness, structured memory.
    const [memoryResult, consciousnessResult, structuredResult] = await Promise.allSettled([
      unifiedMemory ? unifiedMemory.search({ query: message, limit: 5 }) : Promise.resolve([]),
      consciousness
        ? Promise.resolve(consciousness.getIntelligenceBriefContext(message))
        : Promise.resolve(null),
      searchMemories({ query: message, limit: 5 }),
    ]);

    // Map memory results → WisdomHit[]
    const wisdom: WisdomHit[] = [];
    if (memoryResult.status === 'fulfilled') {
      for (const hit of memoryResult.value) {
        const content = hit.content ?? hit.text ?? '';
        if (!content) continue;
        wisdom.push({
          content,
          source: hit.source ?? 'memory',
          relevance: hit.relevance ?? hit.score ?? 0,
        });
      }
    }

    // Map consciousness results → procedures / episodes / predictions
    const procedures: ProceduralHit[] = [];
    const episodes: EpisodicHit[] = [];
    const predictions: WorldModelHit[] = [];

    if (consciousnessResult.status === 'fulfilled' && consciousnessResult.value) {
      const ctx = consciousnessResult.value;

      if (ctx.matchingProcedure) {
        procedures.push({
          procedureName: ctx.matchingProcedure.name,
          steps: ctx.matchingProcedure.steps,
          successRate: ctx.matchingProcedure.successRate,
        });
      }

      for (const ep of ctx.recentEpisodes) {
        episodes.push({
          summary: ep.summary,
          outcome: normaliseOutcome(ep.outcome),
          significance: ep.significance,
          timestamp: ep.timestamp,
        });
      }

      for (const pred of ctx.relevantPredictions) {
        predictions.push({
          domain: pred.domain,
          prediction: pred.prediction,
          confidence: pred.confidence,
          outcome: pred.outcome,
        });
      }
    }

    // Map structured memory results → StructuredMemoryHit[]
    const structuredMemory: StructuredMemoryHit[] = [];
    if (structuredResult.status === 'fulfilled') {
      for (const hit of structuredResult.value) {
        structuredMemory.push({
          id: hit.id,
          type: hit.type,
          name: hit.name,
          description: hit.description,
          snippet: hit.content.substring(0, 300),
          score: hit.score,
        });
      }
    }

    const briefPayload = { wisdom, procedures, episodes, predictions, structuredMemory };
    const formatted = formatBrief(briefPayload);

    return {
      generatedAt: new Date().toISOString(),
      ...briefPayload,
      formatted,
      generationMs: Date.now() - startMs,
    };
  } catch {
    // Non-fatal — return empty brief
    return {
      ...empty,
      generationMs: Date.now() - startMs,
    };
  }
}
