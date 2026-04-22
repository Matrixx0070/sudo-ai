import { createHash } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { PromptCacheManager } from '../memory/prompt-cache.js';

const log = createLogger('brain:prompt-cache-optimizer');

/**
 * Module-level singleton for prompt caching across all calls to
 * buildOptimizedPrompt(). Callers that need to invalidate or inspect cache
 * state can import this directly.
 */
export const promptCache = new PromptCacheManager();

export interface PromptSections {
  stable: string;    // globally cacheable — same across all sessions
  dynamic: string;   // session-specific — changes per user/session
  combined: string;  // full prompt = stable + dynamic (for providers without cache support)
}

export interface CacheStats {
  stableChars: number;
  dynamicChars: number;
  cacheRatio: number;       // stable / total — higher = more cacheable
  estimatedSavings: string; // human-readable estimate
}

/**
 * Split a system prompt into stable (cacheable) and dynamic (session-specific) sections.
 *
 * Stable = everything before the first dynamic marker.
 * Dynamic markers are lines containing: current date, current time, today, session,
 * memory context, active tasks, emotional state, mood, consciousness context.
 */
export function splitPrompt(fullPrompt: string): PromptSections {
  const lines = fullPrompt.split('\n');

  // Dynamic markers — lines containing these are dynamic content
  const DYNAMIC_MARKERS = [
    /^Current date:/i,
    /^Current time/i,
    /^Today is/i,
    /\[Memory Context\]/i,
    /\[Consciousness\]/i,
    /\[Active Tasks\]/i,
    /\[Emotional State\]/i,
    /\[Session\]/i,
    /mood:/i,
    /drive state:/i,
  ];

  // Find the first line that is dynamic
  let splitIndex = lines.length; // default: all stable
  for (let i = 0; i < lines.length; i++) {
    if (DYNAMIC_MARKERS.some((pattern) => pattern.test(lines[i]))) {
      splitIndex = i;
      break;
    }
  }

  const stableLines = lines.slice(0, splitIndex);
  const dynamicLines = lines.slice(splitIndex);

  const stable = stableLines.join('\n').trim();
  const dynamic = dynamicLines.join('\n').trim();
  const combined = fullPrompt;

  log.debug({ stableChars: stable.length, dynamicChars: dynamic.length }, 'Prompt split');

  return { stable, dynamic, combined };
}

/**
 * Calculate cache efficiency stats for a split prompt.
 */
export function getCacheStats(sections: PromptSections): CacheStats {
  const total = sections.stable.length + sections.dynamic.length;
  const cacheRatio = total > 0 ? sections.stable.length / total : 0;
  const estimatedTokensSaved = Math.round(sections.stable.length / 4); // ~4 chars per token
  const estimatedCostSaved = (estimatedTokensSaved * 0.000003).toFixed(4); // $3 per 1M tokens

  return {
    stableChars: sections.stable.length,
    dynamicChars: sections.dynamic.length,
    cacheRatio: Math.round(cacheRatio * 100) / 100,
    estimatedSavings: `~${estimatedTokensSaved} tokens (~$${estimatedCostSaved} per call)`,
  };
}

/**
 * Wrap a stable prompt section with a cache hint comment.
 * Some providers use this as a hint for caching behavior.
 */
export function markAsStable(content: string): string {
  return `<!-- CACHE:STABLE -->\n${content}\n<!-- /CACHE:STABLE -->`;
}

/**
 * Build an optimized system prompt from components, putting stable content first.
 * Dynamic content (date, memory, etc.) goes at the end to minimize cache invalidation.
 */
export function buildOptimizedPrompt(parts: {
  identity: string;            // SOUL.md — stable
  agents: string;              // AGENTS.md — stable
  tools: string;               // tool list — stable (changes rarely)
  dateTime?: string;           // current date/time — dynamic
  memoryContext?: string;      // today's memory — dynamic
  consciousness?: string;      // current mood/drives — dynamic
  customInstructions?: string; // session overrides — dynamic
}): PromptSections {
  // Cache key covers only the stable inputs — dynamic fields change per session
  // and must not produce a stale hit when they differ.
  const cacheKey = createHash('sha256')
    .update(parts.identity ?? '')
    .update('\x00')
    .update(parts.agents ?? '')
    .update('\x00')
    .update(parts.tools ?? '')
    .digest('hex');

  // --- Cache check ---
  const cachedCombined = promptCache.getCachedPrompt(cacheKey);
  if (cachedCombined) {
    log.debug({ cacheKey: cacheKey.slice(0, 12) }, 'buildOptimizedPrompt: cache hit');
    // Re-split so callers get accurate stable/dynamic sections even on a hit.
    return splitPrompt(cachedCombined);
  }

  // --- Build ---
  const stableParts = [parts.identity, parts.agents, parts.tools].filter(Boolean);
  const stable = stableParts.join('\n\n---\n\n');

  // Dynamic section — session-specific
  const dynamicParts = [
    parts.dateTime,
    parts.memoryContext,
    parts.consciousness,
    parts.customInstructions,
  ].filter(Boolean) as string[];
  const dynamic = dynamicParts.join('\n\n');

  const combined = dynamic ? `${stable}\n\n---\n\n${dynamic}` : stable;

  // --- Cache store ---
  if (combined) {
    try {
      promptCache.setCachedPrompt(cacheKey, combined);
      log.debug({ cacheKey: cacheKey.slice(0, 12) }, 'buildOptimizedPrompt: prompt cached');
    } catch (err) {
      log.warn({ err: String(err) }, 'buildOptimizedPrompt: cache store failed — continuing');
    }
  }

  return { stable, dynamic, combined };
}
