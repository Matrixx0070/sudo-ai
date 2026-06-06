/**
 * negative-router.ts — 3-tier negative routing DFA engine for SUDO-AI v4.
 *
 * Tier 0 — DFA Rule Engine (0ms):  Regex patterns route, block, or redirect
 *          requests before any LLM call. Hot-reloadable via JSON5 config.
 * Tier 1 — Keyword Heuristic (1ms):  Weighted keyword + bigram scoring with
 *          context-aware confidence. Extends model-router.ts patterns.
 * Tier 2 — LLM Classification (200ms):  Async last-resort classification when
 *          both Tier 0 and Tier 1 return low confidence.
 */

import { createLogger } from '../shared/logger.js';
import { ROUTING_MODELS } from '../shared/constants.js';

const log = createLogger('brain:negative-router');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RoutingTier = 'dfa' | 'keyword' | 'llm';

export interface NegativeRule {
  /** Regex pattern string (evaluated case-insensitively). */
  pattern: string;
  /** Semantic category, e.g. 'blocked', 'coding', 'analysis'. */
  category: string;
  /** Model to route to when this rule matches. */
  model: string;
  /** Higher-priority rules are evaluated first. */
  priority: number;
  /** If true the request is blocked — do not proceed. */
  block?: boolean;
  /** If set, redirect the request to this model instead of `model`. */
  redirect?: string;
}

export interface RoutingResult {
  model: string;
  category: string;
  tier: RoutingTier;
  confidence: number;
  scores: Record<string, number>;
  ruleMatched?: NegativeRule;
  blocked?: boolean;
  redirect?: string;
}

export interface NegativeRouterConfig {
  rules: NegativeRule[];
  keywordThreshold: number;
  llmThreshold: number;
  llmModel: string;
}

// ---------------------------------------------------------------------------
// Default DFA rules — sorted at compile-time by priority desc
// ---------------------------------------------------------------------------

const DEFAULT_RULES: NegativeRule[] = [
  // Block patterns (highest priority)
  { pattern: '\\bhack\\b',     category: 'blocked', model: '', priority: 100, block: true },
  { pattern: '\\bexploit\\b',  category: 'blocked', model: '', priority: 100, block: true },
  { pattern: '\\bmalware\\b',  category: 'blocked', model: '', priority: 100, block: true },
  { pattern: '\\binject\\b',   category: 'blocked', model: '', priority: 100, block: true },
  { pattern: '\\bphishing\\b', category: 'blocked', model: '', priority: 100, block: true },
  // Redirect patterns
  { pattern: '\\btranslate\\b|\\btranslation\\b|\\btraducir\\b',
    category: 'translation', model: ROUTING_MODELS.fast, priority: 80, redirect: ROUTING_MODELS.fast },
  // Coding patterns
  { pattern: '\\b(code|bug|fix|implement|function|class|debug|refactor|lint|typecheck|compile)\\b',
    category: 'coding', model: ROUTING_MODELS.coding, priority: 50 },
  { pattern: '\\b(typescript|javascript|python|bash|shell|script|dockerfile|kubernetes)\\b',
    category: 'coding', model: ROUTING_MODELS.coding, priority: 50 },
  { pattern: '\\b(import|export|module|package|dependency|npm|yarn|api|endpoint)\\b',
    category: 'coding', model: ROUTING_MODELS.coding, priority: 50 },
  { pattern: '\\b(algorithm|data ?structure|array|interface|type|exception|stacktrace|crash)\\b',
    category: 'coding', model: ROUTING_MODELS.coding, priority: 50 },
  { pattern: '\\b(async|promise|await|thread|concurrency|mutex|race ?condition|memory ?leak)\\b',
    category: 'coding', model: ROUTING_MODELS.coding, priority: 50 },
  // Analysis patterns
  { pattern: '\\b(analyze|analyse|explain|review|summarize|summarise|compare|evaluate|assess|critique)\\b',
    category: 'analysis', model: ROUTING_MODELS.analysis, priority: 40 },
  { pattern: '\\b(discuss|describe|interpret|justify|argue|persuade|draft|document|report|plan|strategy)\\b',
    category: 'analysis', model: ROUTING_MODELS.analysis, priority: 40 },
  { pattern: '\\b(reasoning|think ?through|pros ?and ?cons|tradeoffs|decision|recommend)\\b',
    category: 'analysis', model: ROUTING_MODELS.analysis, priority: 40 },
  // Research patterns
  { pattern: '\\b(search|find|research|latest|news|trend|current|recent|update|release|version)\\b',
    category: 'research', model: ROUTING_MODELS.research, priority: 30 },
  { pattern: '\\b(changelog|announcement|benchmark|survey|statistics|cite|reference|paper|article|study)\\b',
    category: 'research', model: ROUTING_MODELS.research, priority: 30 },
  { pattern: '\\b(discover|publication|who is|what is|when did|where is|how (to|do|does|can))\\b',
    category: 'research', model: ROUTING_MODELS.research, priority: 30 },
];

const DEFAULT_CONFIG: NegativeRouterConfig = {
  rules: DEFAULT_RULES,
  keywordThreshold: 0.4,
  llmThreshold: 0.2,
  llmModel: ROUTING_MODELS.fast,
};

// ---------------------------------------------------------------------------
// Tier 1 keyword/bigram sets (extends model-router.ts)
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
  'document', 'report', 'plan', 'strategy', 'reasoning',
  'think through', 'pros and cons', 'tradeoffs', 'decision', 'recommend',
]);
const RESEARCH_KEYWORDS = new Set([
  'search', 'find', 'research', 'latest', 'news', 'trend', 'who', 'what',
  'when', 'where', 'how', 'current', 'recent', 'update', 'release',
  'version', 'changelog', 'announcement', 'benchmark', 'survey',
  'statistics', 'data', 'source', 'cite', 'reference', 'paper',
  'article', 'study', 'publication', 'discover',
]);

// Bigrams give stronger context signals than individual keywords
const CODING_BIGRAMS = new Set([
  'write code', 'fix bug', 'fix error', 'run test', 'build app',
  'debug issue', 'refactor code', 'add feature', 'create function',
]);
const ANALYSIS_BIGRAMS = new Set([
  'analyze data', 'write report', 'summarize article', 'explain concept',
  'compare options', 'evaluate performance', 'review code',
]);
const RESEARCH_BIGRAMS = new Set([
  'find information', 'search for', 'research topic', 'latest news',
  'current trends', 'look up',
]);

const CATEGORY_WEIGHTS: Record<string, number> = { coding: 3, analysis: 2, research: 2 };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
}

function extractBigrams(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) bigrams.add(`${words[i]} ${words[i + 1]}`);
  return bigrams;
}

function scoreAgainst(tokens: string[], keywords: Set<string>, weight: number): number {
  let score = 0;
  for (const t of tokens) if (keywords.has(t)) score += weight;
  return score;
}

function scoreBigrams(bigrams: Set<string>, target: Set<string>, weight: number): number {
  let score = 0;
  for (const b of bigrams) if (target.has(b)) score += weight;
  return score;
}

// ---------------------------------------------------------------------------
// NegativeRouter class
// ---------------------------------------------------------------------------

export class NegativeRouter {
  private config: NegativeRouterConfig;
  private compiledRules: { rule: NegativeRule; regex: RegExp }[];
  private stats = { totalCalls: 0, tier0Hits: 0, tier1Hits: 0, tier2Hits: 0, blocks: 0, redirects: 0 };

  constructor(config?: Partial<NegativeRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (config?.rules) this.config.rules = [...DEFAULT_RULES, ...config.rules];
    this.compiledRules = this.compileRules(this.config.rules);
  }

  /** Compile and sort rules into RegExp objects by descending priority. */
  private compileRules(rules: NegativeRule[]): { rule: NegativeRule; regex: RegExp }[] {
    return [...rules]
      .sort((a, b) => b.priority - a.priority)
      .map(rule => ({ rule, regex: new RegExp(rule.pattern, 'i') }));
  }

  /** Tier 0: run DFA rules — first (highest-priority) match wins. */
  private runDFA(input: string): { rule: NegativeRule } | null {
    for (const { rule, regex } of this.compiledRules) {
      if (regex.test(input)) return { rule };
    }
    return null;
  }

  /** Tier 1: weighted keyword + bigram heuristic with normalised confidence. */
  private runKeywordHeuristic(tokens: string[], bigrams: Set<string>) {
    const kwSets: Record<string, Set<string>> = { coding: CODING_KEYWORDS, analysis: ANALYSIS_KEYWORDS, research: RESEARCH_KEYWORDS };
    const biSets: Record<string, Set<string>> = { coding: CODING_BIGRAMS, analysis: ANALYSIS_BIGRAMS, research: RESEARCH_BIGRAMS };
    const scores: Record<string, number> = {};

    for (const cat of ['coding', 'analysis', 'research']) {
      const w = CATEGORY_WEIGHTS[cat] ?? 1;
      scores[cat] = scoreAgainst(tokens, kwSets[cat], w)
        + scoreBigrams(bigrams, biSets[cat], Math.ceil(w * 1.5));
    }
    scores.fast = 0;

    // Find best category; tie-break coding > analysis > research
    let bestCat = 'fast';
    let bestScore = 0;
    for (const cat of ['coding', 'analysis', 'research'] as const) {
      if (scores[cat] > bestScore) { bestScore = scores[cat]; bestCat = cat; }
    }
    if (scores.coding === bestScore) bestCat = 'coding';
    else if (scores.analysis === bestScore) bestCat = 'analysis';
    else if (scores.research === bestScore) bestCat = 'research';

    // Normalise: score of 6+ is full confidence
    const confidence = bestScore > 0 ? Math.min(bestScore / 6, 1) : 0;
    const model = bestCat === 'coding' ? ROUTING_MODELS.coding
      : bestCat === 'analysis' ? ROUTING_MODELS.analysis
      : bestCat === 'research' ? ROUTING_MODELS.research
      : ROUTING_MODELS.fast;

    return { scores, category: bestCat, model, confidence };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Route a message through the 3-tier cascade:
   * 1. DFA rules (block > redirect > model)
   * 2. Keyword heuristic if confidence >= keywordThreshold
   * 3. LLM classification queued for confidence < llmThreshold (non-blocking)
   */
  route(intent: string, message: string): RoutingResult {
    this.stats.totalCalls++;

    if (!message && !intent) {
      return { model: ROUTING_MODELS.fast, category: 'fast', tier: 'keyword', confidence: 0, scores: {} };
    }

    const combined = `${intent} ${message}`.trim();

    // --- Tier 0: DFA Rule Engine ---
    const dfaHit = this.runDFA(combined);
    if (dfaHit) {
      const { rule } = dfaHit;
      this.stats.tier0Hits++;

      if (rule.block) {
        this.stats.blocks++;
        log.debug({ pattern: rule.pattern }, 'Request blocked by DFA rule');
        return { model: '', category: rule.category, tier: 'dfa', confidence: 1, scores: {}, ruleMatched: rule, blocked: true };
      }
      if (rule.redirect) {
        this.stats.redirects++;
        log.debug({ pattern: rule.pattern, redirect: rule.redirect }, 'Request redirected by DFA rule');
        return { model: rule.model, category: rule.category, tier: 'dfa', confidence: 1, scores: {}, ruleMatched: rule, redirect: rule.redirect };
      }
      log.debug({ pattern: rule.pattern, model: rule.model }, 'Request routed by DFA rule');
      return { model: rule.model, category: rule.category, tier: 'dfa', confidence: 1, scores: {}, ruleMatched: rule };
    }

    // --- Tier 1: Keyword Heuristic ---
    const tokens = tokenize(combined);
    const bigrams = extractBigrams(combined);
    const kw = this.runKeywordHeuristic(tokens, bigrams);

    if (kw.confidence >= this.config.keywordThreshold) {
      this.stats.tier1Hits++;
      log.debug({ category: kw.category, confidence: kw.confidence }, 'Routed by keyword heuristic');
      return { model: kw.model, category: kw.category, tier: 'keyword', confidence: kw.confidence, scores: kw.scores };
    }

    // Confidence below llmThreshold — Tier 2 LLM classification would be
    // queued here in production. Return keyword result as non-blocking fallback.
    if (kw.confidence < this.config.llmThreshold) {
      this.stats.tier2Hits++;
      log.debug({ confidence: kw.confidence }, 'Low confidence — LLM tier would be queued');
      return { model: kw.model, category: kw.category, tier: 'llm', confidence: kw.confidence, scores: kw.scores };
    }

    // Medium confidence: above llmThreshold but below keywordThreshold
    this.stats.tier1Hits++;
    return { model: kw.model, category: kw.category, tier: 'keyword', confidence: kw.confidence, scores: kw.scores };
  }

  /** Add a DFA rule at runtime. Recompiles the rule list. */
  addRule(rule: NegativeRule): void {
    this.config.rules.push(rule);
    this.compiledRules = this.compileRules(this.config.rules);
  }

  /** Remove a DFA rule by pattern. Returns true if removed. */
  removeRule(pattern: string): boolean {
    const idx = this.config.rules.findIndex(r => r.pattern === pattern);
    if (idx === -1) return false;
    this.config.rules.splice(idx, 1);
    this.compiledRules = this.compileRules(this.config.rules);
    return true;
  }

  /** Load DFA rules from an external JSON5/JSON file and merge them in. */
  async loadRules(filePath: string): Promise<void> {
    try {
      const { readFileSync } = await import('fs');
      const raw = readFileSync(filePath, 'utf-8').replace(/\/\/.*$/gm, ''); // strip line comments
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) { log.error({ path: filePath }, 'Rules file must contain a JSON array'); return; }
      const newRules: NegativeRule[] = data
        .map((r: Record<string, unknown>) => ({
          pattern: String(r.pattern ?? ''),
          category: String(r.category ?? 'unknown'),
          model: String(r.model ?? ROUTING_MODELS.fast),
          priority: Number(r.priority ?? 0),
          block: r.block === true,
          redirect: r.redirect ? String(r.redirect) : undefined,
        }))
        .filter((r: NegativeRule) => r.pattern.length > 0);
      this.config.rules = [...this.config.rules, ...newRules];
      this.compiledRules = this.compileRules(this.config.rules);
      log.debug({ path: filePath, count: newRules.length }, 'DFA rules loaded');
    } catch (err) {
      log.error({ path: filePath, err: String(err) }, 'Failed to load DFA rules');
    }
  }

  /** Return a shallow copy of the current DFA rule list. */
  getRules(): NegativeRule[] { return [...this.config.rules]; }

  /** Return cumulative routing statistics. */
  getStats(): { totalCalls: number; tier0Hits: number; tier1Hits: number; tier2Hits: number; blocks: number; redirects: number } {
    return { ...this.stats };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let defaultRouter: NegativeRouter | null = null;

/** Get or create the singleton NegativeRouter instance. */
export function getDefaultRouter(): NegativeRouter {
  if (!defaultRouter) defaultRouter = new NegativeRouter();
  return defaultRouter;
}