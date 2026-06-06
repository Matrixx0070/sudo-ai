/**
 * model-router.ts
 *
 * Smart model routing for SUDO-AI v4.
 * Routes tasks to the best available model based on keyword analysis of the
 * user message and the intent string produced by the intent classifier.
 *
 * The router is intentionally zero-cost: pure keyword matching, no LLM calls.
 * Follows the same pattern as tool-router.ts already in the codebase.
 */

import { createLogger } from '../shared/logger.js';
import { ROUTING_MODELS } from '../shared/constants.js';

const log = createLogger('brain:model-router');

// ---------------------------------------------------------------------------
// Keyword sets — all lower-case for fast comparison
// ---------------------------------------------------------------------------

const CODING_KEYWORDS = new Set([
  'code', 'bug', 'fix', 'implement', 'function', 'class', 'error',
  'compile', 'debug', 'test', 'refactor', 'lint', 'typecheck', 'syntax',
  'typescript', 'javascript', 'python', 'bash', 'shell', 'script',
  'import', 'export', 'module', 'package', 'dependency', 'npm', 'yarn',
  'build', 'deploy', 'dockerfile', 'kubernetes', 'api', 'endpoint',
  'algorithm', 'data structure', 'array', 'object', 'interface', 'type',
  'exception', 'stacktrace', 'crash', 'segfault', 'memory leak', 'async',
  'promise', 'await', 'thread', 'concurrency', 'mutex', 'race condition',
]);

const ANALYSIS_KEYWORDS = new Set([
  'analyze', 'analyse', 'explain', 'review', 'write', 'essay', 'summarize',
  'summarise', 'compare', 'evaluate', 'assess', 'critique', 'discuss',
  'describe', 'interpret', 'justify', 'argue', 'persuade', 'draft',
  'document', 'report', 'plan', 'strategy', 'reasoning', 'reasoning',
  'think through', 'pros and cons', 'tradeoffs', 'decision', 'recommend',
]);

const RESEARCH_KEYWORDS = new Set([
  'search', 'find', 'research', 'latest', 'news', 'trend', 'who', 'what',
  'when', 'where', 'how', 'current', 'recent', 'update', 'release',
  'version', 'changelog', 'announcement', 'benchmark', 'survey',
  'statistics', 'data', 'source', 'cite', 'reference', 'paper',
  'article', 'study', 'publication', 'discover',
]);

// ---------------------------------------------------------------------------
// Category score weights
// ---------------------------------------------------------------------------

const WEIGHT_CODING = 3;
const WEIGHT_ANALYSIS = 2;
const WEIGHT_RESEARCH = 2;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Tokenise a string into lower-cased words for keyword matching.
 * Splits on whitespace and strips non-alphanumeric characters.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
}

/**
 * Score a token list against a keyword set.
 * Each hit increments the score by `weight`.
 */
function scoreAgainst(tokens: string[], keywords: Set<string>, weight: number): number {
  let score = 0;
  for (const token of tokens) {
    if (keywords.has(token)) score += weight;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RouterCategory = 'coding' | 'analysis' | 'research' | 'fast';

export interface RoutingDecision {
  /** The fully-qualified model string to use, e.g. "ollama/deepseek-v4-pro:cloud". */
  model: string;
  /** The routing category that was selected. */
  category: RouterCategory;
  /** Scores per category (for diagnostics/logging). */
  scores: Record<RouterCategory, number>;
}

/**
 * Route a message to the optimal model.
 *
 * @param intent  - Intent string from the intent classifier (may be empty).
 * @param message - The raw user message.
 * @returns RoutingDecision containing the selected model string and metadata.
 */
export function routeModel(intent: string, message: string): RoutingDecision {
  if (!message && !intent) {
    log.debug('Empty message and intent — defaulting to fast model');
    return {
      model: ROUTING_MODELS.fast,
      category: 'fast',
      scores: { coding: 0, analysis: 0, research: 0, fast: 0 },
    };
  }

  const combined = `${intent} ${message}`;
  const tokens = tokenize(combined);

  const codingScore = scoreAgainst(tokens, CODING_KEYWORDS, WEIGHT_CODING);
  const analysisScore = scoreAgainst(tokens, ANALYSIS_KEYWORDS, WEIGHT_ANALYSIS);
  const researchScore = scoreAgainst(tokens, RESEARCH_KEYWORDS, WEIGHT_RESEARCH);

  const scores: Record<RouterCategory, number> = {
    coding: codingScore,
    analysis: analysisScore,
    research: researchScore,
    fast: 0, // always tied-last; wins only when all others are 0
  };

  let category: RouterCategory = 'fast';
  let model: string = ROUTING_MODELS.fast;
  const maxScore = Math.max(codingScore, analysisScore, researchScore);

  if (maxScore > 0) {
    // Resolve ties in favour of higher-precision models (coding > analysis > research).
    if (codingScore === maxScore) {
      category = 'coding';
      model = ROUTING_MODELS.coding;
    } else if (analysisScore === maxScore) {
      category = 'analysis';
      model = ROUTING_MODELS.analysis;
    } else {
      category = 'research';
      model = ROUTING_MODELS.research;
    }
  }

  log.debug(
    { scores, category, model, tokenCount: tokens.length },
    'Model routing decision',
  );

  return { model, category, scores };
}

/**
 * Return true when `modelString` means "let the router decide".
 * Callers should call routeModel() and use its result instead.
 */
export function isAutoModel(modelString: string | undefined): boolean {
  return !modelString || modelString === 'auto' || modelString === '';
}
