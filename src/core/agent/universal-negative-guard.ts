/**
 * @file universal-negative-guard.ts
 * @description Final-answer universal-negative guard.
 *
 * A prompt-only rule ("don't assert universal negatives from narrow
 * searches") was live-proven insufficient: the agent runs broad searches,
 * adds a "what I did NOT find" section — and then still concludes with a
 * bare universal negative stated as fact ("there are **no name collisions**;
 * no other entity uses it"). This module is the STRUCTURAL backstop: it
 * mechanically scans the FINAL answer of research turns for unqualified
 * universal-negative-of-existence claims and triggers a single bounded
 * corrective self-revision that rescopes the claim to what the searches
 * actually showed ("I didn't find another X in my searches; I can't fully
 * rule it out").
 *
 * Precision guardrails (deliberately biased toward missing some cases
 * rather than corrupting correct negatives):
 *   - Fires only on research turns — the run must have used web/browser
 *     tools (browser.search / browser.fetch / web_search / …).
 *   - Sentences that already hedge ("I didn't find…", "in my searches…",
 *     "can't fully rule out…") are NOT flagged.
 *   - Sentences about local, verifiable negatives (files, rows, functions,
 *     paths, logs, tables, …) are NOT flagged — "no file at that path" and
 *     "0 rows returned" are correct local checks.
 *   - Code fences and inline code are stripped before analysis.
 *
 * Safety: kill-switch `SUDO_UNIVERSAL_NEGATIVE_GUARD` (default ON; `=0`
 * disables), fail-open on every error path, at most ONE corrective model
 * pass per turn (no regeneration loops). If the revision itself still
 * contains an unqualified universal negative (or errors / comes back
 * empty), the guard falls back to appending a mechanical scope caveat so
 * the answer is never silently left overclaiming after a flag.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:universal-negative-guard');

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

/**
 * Returns true unless `SUDO_UNIVERSAL_NEGATIVE_GUARD=0`. Default ON per repo
 * default-on policy; the guard is additionally scoped to research turns only.
 */
export function isUniversalNegativeGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_UNIVERSAL_NEGATIVE_GUARD'] !== '0';
}

// ---------------------------------------------------------------------------
// Research-turn scoping
// ---------------------------------------------------------------------------

/**
 * True when a tool name is a web/research tool — the class of tools whose
 * "absence of evidence" is NEVER "evidence of absence". Local search tools
 * (file/grep/memory/rag) are deliberately excluded: their negatives are
 * verifiable ("no rows", "no file") and must not trip the guard.
 */
export function isResearchToolName(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('browser.')) return true;
  // web_search / websearch / search_web / web.fetch / fetch_url style names
  // (native + MCP aliases). Segment-anchored so e.g. "comms.webhook" or
  // "memory.search" do not match.
  return /(^|[._-])(web|websearch|web_search|search_web|fetch_url)([._-]|$)/.test(n);
}

/** True when any tool used this run is a research tool. */
export function usedResearchTools(toolNamesUsed: readonly string[]): boolean {
  return toolNamesUsed.some((t) => isResearchToolName(t));
}

// ---------------------------------------------------------------------------
// Detection (pure)
// ---------------------------------------------------------------------------

/**
 * Hedge / scope markers: a sentence carrying one of these already scopes its
 * negative claim to the search actually performed, so it is NOT flagged.
 */
const HEDGE_RE = new RegExp(
  [
    String.raw`\bdidn'?t find\b`,
    String.raw`\bdid not find\b`,
    String.raw`\bcouldn'?t find\b`,
    String.raw`\bcould not find\b`,
    String.raw`\bfound no\b`,
    String.raw`\bfound none\b`,
    String.raw`\bin (?:my|the|these|those) search(?:es)?\b`,
    String.raw`\bbased on (?:my|the|these|those) (?:search(?:es)?|results?|sources?)\b`,
    String.raw`\bcan(?:'?t|not) (?:fully |completely |definitively )?rule\b`,
    String.raw`\bcannot be (?:fully |completely )?ruled out\b`,
    String.raw`\bmay (?:still )?exist\b`,
    String.raw`\bmight (?:still )?exist\b`,
    String.raw`\bcould (?:still )?exist\b`,
    String.raw`\bas far as (?:i|my search(?:es)?)\b`,
    String.raw`\b(?:searches?|results?) (?:did not|didn'?t|don'?t) (?:turn up|surface|show|reveal|return)\b`,
    String.raw`\bturned up (?:no|nothing)\b`,
    String.raw`\bno (?:\S+ )*?(?:turned up|surfaced|appeared) in\b`,
    String.raw`\bnot (?:fully |completely )?(?:exhaustive|conclusive)\b`,
  ].join('|'),
  'i',
);

/**
 * Local-context markers: negatives about files, rows, functions, paths, etc.
 * are verifiable local checks (the agent CAN exhaustively check them), so a
 * sentence carrying one of these is NOT flagged.
 */
const LOCAL_CONTEXT_RE = new RegExp(
  [
    String.raw`\b(?:file|files|filename|path|paths|directory|directories|folder|folders)\b`,
    String.raw`\b(?:repo|repos|repository|repositories|codebase|branch|branches|commit|commits)\b`,
    String.raw`\b(?:function|functions|method|methods|class|classes|variable|variables|module|modules|import|imports|export|exports)\b`,
    String.raw`\b(?:row|rows|record|records|table|tables|column|columns|database|db|query|queries)\b`,
    String.raw`\b(?:log|logs|output|stdout|stderr|config|configs|env|endpoint|endpoints|route|routes)\b`,
    String.raw`\b(?:test|tests|suite|line|lines|schema|package|dependency|dependencies)\b`,
    String.raw`/[\w.\-]+/[\w.\-/]+`, // an absolute-ish path like /tmp/x or /a/b
  ].join('|'),
  'i',
);

/**
 * Unqualified universal-negative-of-existence patterns. Each is evaluated
 * per sentence, after hedge + local-context exclusion.
 */
const NEGATIVE_PATTERNS: RegExp[] = [
  // "no other <thing> exists / uses / has / is …", "no other OpenClaw exists"
  /\bno other\b[^.!?\n]*\b(?:exist(?:s|ed)?|use(?:s|d)?|using|ha(?:s|ve|d)|is|are|was|were|match(?:es|ed)?)\b/i,
  // "there is/are no other …", "there is no such …"
  /\bthere (?:is|are|was|were) no (?:other|such)\b/i,
  // "no (name) collision(s)"; bare "no conflicts" is deliberately NOT
  // matched (too common in merge/rebase contexts) — qualified conflicts are.
  /\bno (?:name |naming |trademark )?collisions?\b|\bno (?:name |naming |trademark )conflicts?\b/i,
  // "does not / did not / never exist(ed)"
  /\b(?:does not|doesn'?t|did not|didn'?t) exist\b|\bnever existed\b/i,
  // "nothing else … exists / matches / uses"
  /\bnothing else\b[^.!?\n]*\b(?:exist(?:s|ed)?|match(?:es|ed)?|use(?:s|d)?)\b/i,
  // "no one / nobody else uses / has …"
  /\b(?:no one|nobody) else\b[^.!?\n]*\b(?:use(?:s|d)?|ha(?:s|ve|d)|exist(?:s|ed)?)\b/i,
  // "… is the only … in existence / of its kind / with this name"
  /\b(?:is|was|remains) the only\b[^.!?\n]*\b(?:in existence|of its kind|ever|anywhere|with (?:this|that|the) name)\b/i,
  // "the name is unique … no other" / "unique — no other" (belt+braces; the
  // `no other` pattern usually catches these already)
  /\bunique\b[^.!?\n]*\bno other\b/i,
];

/** Strip fenced code blocks and inline code so code content never trips the detector. */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/** Split into sentence-ish units; markdown emphasis removed so `**no**` matches. */
function splitSentences(text: string): string[] {
  const cleaned = stripCode(text).replace(/\*\*|__|\*|_/g, '');
  return cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Detect unqualified universal-negative-of-existence claims in an answer.
 * Pure function; returns the offending sentences (empty array = clean).
 *
 * Precision bias: hedged sentences and local-context (verifiable) negatives
 * are never returned — better to miss some overclaims than to corrupt
 * correct negatives.
 */
export function detectUniversalNegatives(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  const flagged: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (HEDGE_RE.test(sentence)) continue;
    if (LOCAL_CONTEXT_RE.test(sentence)) continue;
    if (NEGATIVE_PATTERNS.some((re) => re.test(sentence))) {
      flagged.push(sentence);
    }
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// Guard action — one bounded corrective self-revision, fail-open
// ---------------------------------------------------------------------------

/** Mechanical fallback caveat appended when the corrective pass cannot be adopted. */
export const SCOPE_CAVEAT =
  '\n\n> Scope note: any "does not exist / no other / no collision" statement above ' +
  'reflects only the searches performed this turn — they were not exhaustive, so ' +
  'such possibilities cannot be fully ruled out.';

export interface UniversalNegativeGuardOptions {
  /** The final answer text about to be returned to the user. */
  answer: string;
  /** Tool names actually invoked this run (per-run sequence, not history). */
  toolNamesUsed: readonly string[];
  /** The original user request (context for the corrective pass). */
  originalRequest: string;
  /**
   * One corrective model call: given a revision prompt, return the revised
   * full answer. The guard invokes this AT MOST once.
   */
  revise: (prompt: string) => Promise<string>;
  /** Env override (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface UniversalNegativeGuardResult {
  /** The answer to return — original, revised, or original+caveat. */
  answer: string;
  /** Offending sentences detected in the original answer. */
  flagged: string[];
  /** What the guard did. */
  action: 'off' | 'not-research-turn' | 'clean' | 'revised' | 'caveat-appended' | 'error';
}

/** Build the single corrective-revision prompt. */
export function buildRevisionPrompt(answer: string, flagged: string[], originalRequest: string): string {
  return [
    'Your reply below asserts universal negatives ("X does not exist", "no other X", "no collisions")',
    'as established fact, but it is based on a finite number of web searches, which can never prove',
    'non-existence. Rewrite ONLY the offending sentences so they are scoped to what the searches',
    'actually showed — e.g. "I didn\'t find any other X in my searches, so I can\'t fully rule it out."',
    'Keep everything else (facts, structure, findings) unchanged. Return the complete revised reply',
    'and nothing else.',
    '',
    '--- OFFENDING SENTENCES ---',
    ...flagged.map((s) => `- ${s}`),
    '',
    '--- ORIGINAL REQUEST ---',
    originalRequest.slice(0, 2000),
    '',
    '--- YOUR REPLY ---',
    answer,
  ].join('\n');
}

/**
 * Run the guard over a final answer. Never throws; on any internal error the
 * ORIGINAL answer is returned untouched (fail-open). At most one `revise`
 * call is made — no loops.
 */
export async function runUniversalNegativeGuard(
  opts: UniversalNegativeGuardOptions,
): Promise<UniversalNegativeGuardResult> {
  const { answer } = opts;
  try {
    if (!isUniversalNegativeGuardEnabled(opts.env)) {
      return { answer, flagged: [], action: 'off' };
    }
    if (!usedResearchTools(opts.toolNamesUsed)) {
      return { answer, flagged: [], action: 'not-research-turn' };
    }
    const flagged = detectUniversalNegatives(answer);
    if (flagged.length === 0) {
      return { answer, flagged, action: 'clean' };
    }
    log.warn(
      { flaggedCount: flagged.length, first: flagged[0]?.slice(0, 160) },
      'UniversalNegativeGuard: unqualified universal negative in final research answer — one corrective pass',
    );
    let revised = '';
    try {
      revised = await opts.revise(buildRevisionPrompt(answer, flagged, opts.originalRequest));
    } catch (err) {
      log.warn({ err: String(err) }, 'UniversalNegativeGuard: corrective pass threw — appending scope caveat');
      return { answer: answer + SCOPE_CAVEAT, flagged, action: 'caveat-appended' };
    }
    const trimmed = (revised ?? '').trim();
    // Adopt the revision ONLY if it is non-empty and itself clean; otherwise
    // fall back to the mechanical caveat (still bounded — no second pass).
    if (trimmed !== '' && detectUniversalNegatives(trimmed).length === 0) {
      log.info({ lenBefore: answer.length, lenAfter: trimmed.length }, 'UniversalNegativeGuard: revision adopted');
      return { answer: trimmed, flagged, action: 'revised' };
    }
    log.warn(
      { emptyRevision: trimmed === '' },
      'UniversalNegativeGuard: revision unusable (empty or still overclaiming) — appending scope caveat',
    );
    return { answer: answer + SCOPE_CAVEAT, flagged, action: 'caveat-appended' };
  } catch (err) {
    log.warn({ err: String(err) }, 'UniversalNegativeGuard: guard error — failing open with original answer');
    return { answer, flagged: [], action: 'error' };
  }
}
