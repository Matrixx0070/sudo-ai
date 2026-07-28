/**
 * cheap-model-router.ts
 *
 * Hermes-inspired smart model routing for SUDO-AI v4.
 * Routes short, conversational messages to a cheaper model
 * and falls back to the primary model whenever any complexity
 * signal is detected.  Conservative by design — the primary
 * model is always the safe default.
 *
 * Enabled only when both env vars are set:
 *   SUDO_SMART_ROUTE_CHEAP=1
 *   SUDO_CHEAP_MODEL=<model-id>   (e.g. grok-3-mini)
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:cheap-model-router');

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Maximum character length before routing to primary. */
const MAX_CHARS = 400;

/** Maximum word count before routing to primary. */
const MAX_WORDS = 80;

/** Number of recent history messages to inspect for tool calls.
 * R-4 (Security): Increased from 5 to 10 to catch agentic tasks that span
 * more turns before the cheap model would be permitted. */
const HISTORY_TOOL_CALL_LOOKBACK = 10;

/**
 * Keywords that signal a complex, agentic request.
 * Any match forces routing to the primary model.
 */
const COMPLEXITY_KEYWORDS = /\b(debug|implement|test|docker|deploy|refactor|optimize|architect|analyze|analyse|review|compile|build)\b/i;

/** Matches any fenced code block (``` ... ```) in the message. */
const CODE_BLOCK_RE = /```/;

/** Matches URLs and dangerous protocol schemes including data:, javascript:, vbscript:,
 * protocol-relative (//host), and file:// URIs. */
// NOTE (R-1 carry-over): The cheap model downgrade is controlled by operator env vars
// (SUDO_SMART_ROUTE_CHEAP + SUDO_CHEAP_MODEL). Operators must ensure the cheap model
// satisfies the same safety bar as the primary model; this router does not validate
// the model itself. See deployment guide for guidance.
const URL_RE = /https?:\/\/|ftp:\/\/|www\.|\/\/[a-z0-9]|data:|javascript:|vbscript:|file:\/\//i;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal duck-typed shape of a history message.
 * Matches BrainMessage from loop-helpers.ts without importing it directly
 * (avoiding circular-import risk).
 */
export interface HistoryMessage {
  role: string;
  toolCalls?: unknown[];
  /** Optional indicator set by callers when the message has file attachments. */
  hasAttachments?: boolean;
}

/** Input to `chooseModel`. */
export interface ChooseModelInput {
  /** The raw user text for this turn. */
  userText: string;
  /** Recent conversation history (older messages first). */
  history: HistoryMessage[];
  /** Primary (full-capability) model identifier. */
  primaryModel: string;
  /** Cheaper model identifier to use on simple turns. */
  cheapModel: string;
  /** Explicitly signal that attachments are present on this turn. */
  hasAttachments?: boolean;
}

/** Result of `chooseModel`. */
export interface ChooseModelResult {
  /** The model identifier to actually use for this brain.call(). */
  model: string;
  /** Human-readable explanation of the routing decision. */
  reason: string;
  /** `true` when the cheap model was selected. */
  cheapUsed: boolean;
  /** AL6.4: the intent class behind the decision — logged and evaluable. */
  intent: 'conversational' | 'agentic' | 'unknown';
}

/** AL6.4 classification result — the routing heuristic's verdict as data. */
export interface IntentClassification {
  intent: 'conversational' | 'agentic' | 'unknown';
  reason: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Count words in a string using whitespace splitting. */
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Check whether any of the last N history messages contain tool calls,
 * which indicates the session is mid-agentic-task.
 */
function recentHistoryHasToolCalls(history: HistoryMessage[], lookback: number): boolean {
  const recent = history.slice(-lookback);
  return recent.some((m) => Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * AL6.4: classify the turn's intent using the SAME guards that have always
 * driven the routing decision — extracted as data so the classification is
 * logged and evaluable (a misroute becomes an AL7 eval case). `chooseModel`
 * delegates here; behavior and reason strings are unchanged.
 */
export function classifyIntent(
  input: Pick<ChooseModelInput, 'userText' | 'history' | 'hasAttachments'>,
): IntentClassification {
  const { userText, history, hasAttachments = false } = input;

  if (!userText || userText.trim().length === 0) {
    return { intent: 'unknown', reason: 'empty user text — defaulting to primary' };
  }
  if (userText.length > MAX_CHARS) {
    return { intent: 'agentic', reason: `text length ${userText.length} > ${MAX_CHARS} chars` };
  }
  const words = wordCount(userText);
  if (words > MAX_WORDS) {
    return { intent: 'agentic', reason: `word count ${words} > ${MAX_WORDS}` };
  }
  if (CODE_BLOCK_RE.test(userText)) {
    return { intent: 'agentic', reason: 'message contains a code block' };
  }
  if (URL_RE.test(userText)) {
    return { intent: 'agentic', reason: 'message contains a URL' };
  }
  const kw = userText.match(COMPLEXITY_KEYWORDS);
  if (kw) {
    return { intent: 'agentic', reason: `complexity keyword detected: "${kw[0]}"` };
  }
  if (recentHistoryHasToolCalls(history, HISTORY_TOOL_CALL_LOOKBACK)) {
    return { intent: 'agentic', reason: 'recent tool calls detected in history — agentic task in progress' };
  }
  if (hasAttachments) {
    return { intent: 'agentic', reason: 'turn has attachments' };
  }
  return { intent: 'conversational', reason: 'simple conversational turn' };
}

/**
 * Decide which model to use for the upcoming brain call.
 *
 * Returns the cheap model only when the intent classifies as conversational
 * (all guards pass: length, word count, no code block / URL / complexity
 * keyword / recent tool calls / attachments). Anything else — including
 * empty text — rides the primary model. Conservative by design.
 */
export function chooseModel(input: ChooseModelInput): ChooseModelResult {
  const { primaryModel, cheapModel } = input;
  const { intent, reason } = classifyIntent(input);

  // AL6.4: classification logged and evaluable (one line per routed turn).
  log.info({ intent, reason, cheapEligible: intent === 'conversational' }, 'intent classified');

  if (intent !== 'conversational') {
    log.debug({ reason }, 'cheap-model-router: primary model selected');
    return { model: primaryModel, reason, cheapUsed: false, intent };
  }
  log.debug({ chars: input.userText.length, cheapModel }, 'cheap-model-router: cheap model selected');
  return { model: cheapModel, reason, cheapUsed: true, intent };
}
