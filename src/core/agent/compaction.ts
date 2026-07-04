/**
 * Context compaction for the SUDO-AI agent loop.
 *
 * When the conversation grows too long the loop calls compact() to ask the
 * LLM to produce a structured summary. The summary replaces the raw history,
 * keeping the session within the context window while preserving critical state.
 */

import { createLogger } from '../shared/logger.js';
import { MAX_COMPACTION_CHARS } from '../shared/constants.js';
import { PipelineError } from '../shared/errors.js';

const log = createLogger('agent:compaction');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of retry attempts when a compaction summary is malformed. */
const MAX_COMPACTION_RETRIES = 3 as const;

/**
 * The five required section headers that a valid compaction summary must
 * contain. The quality guard validates all five are present before accepting.
 */
const REQUIRED_SECTIONS = [
  'Decisions',
  'Open TODOs',
  'Constraints',
  'Pending asks',
  'Identifiers',
] as const;

// ---------------------------------------------------------------------------
// Interfaces for duck-typing the brain dependency
// ---------------------------------------------------------------------------

/** Minimal BrainRequest shape needed by compaction. */
interface CompactionRequest {
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  source?: string;
}

/** Minimal BrainResponse shape returned by brain.call(). */
interface CompactionResponse {
  content: string;
}

/**
 * Duck-typed brain interface — avoids circular imports. The optional
 * second `opts` arg lets compaction pass a tier hint (`'high-stakes'`)
 * so the env-driven strategy upgrade from PR #242 can promote the
 * summary call to debate/tree-search. Existing minimal mocks without
 * the opts arg still satisfy this contract structurally.
 */
interface BrainLike {
  call(
    request: CompactionRequest,
    opts?: { tier?: 'fast' | 'routine' | 'high-stakes' },
  ): Promise<CompactionResponse>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the system instruction for the compaction call. */
function buildCompactionSystemPrompt(): string {
  return [
    'You are a conversation summariser. Your task is to distil the provided',
    'conversation history into a compact, structured briefing.',
    '',
    'Output EXACTLY five sections using these markdown headings in this order:',
    '## Decisions',
    '## Open TODOs',
    '## Constraints',
    '## Pending asks',
    '## Identifiers',
    '',
    'Rules:',
    '- Be concise. Each section should use bullet points.',
    '- Decisions: key choices already made.',
    '- Open TODOs: tasks still outstanding.',
    '- Constraints: hard limits or rules the agent must respect.',
    '- Pending asks: things the user or agent is waiting for.',
    '- Identifiers: important IDs, paths, URLs, names referenced in the session.',
    '- Never include raw tool output; summarise only what matters.',
    `- Total response must not exceed ${MAX_COMPACTION_CHARS} characters.`,
  ].join('\n');
}

/** Build the user turn that contains the conversation to compact. */
/** Minimum length for a user message to be eligible for compaction dedupe. */
const MIN_DEDUPE_USER_CHARS = 24;

/** Normalize text for duplicate detection: NFC, lowercase, whitespace-collapsed. */
function normalizeForDedupe(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Drop LATER duplicate user turns before summarisation. A user who re-sends the
 * same prompt (a retry, or a client that re-delivers) otherwise inflates the
 * summariser input and biases the summary toward the repeated ask. Only long
 * messages (>= 24 chars) are deduped — short acks ("next", "yes") are kept — and
 * the FIRST occurrence always survives. Operates on a COPY; history is untouched.
 * Kill-switch: SUDO_COMPACT_DEDUPE_USERS=0.
 */
export function dedupeUserMessagesForCompaction(messages: unknown[]): unknown[] {
  if (process.env['SUDO_COMPACT_DEDUPE_USERS'] === '0') return messages;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const m of messages) {
    const msg = m as Record<string, unknown>;
    if (
      msg['role'] === 'user' &&
      typeof msg['content'] === 'string' &&
      (msg['content'] as string).length >= MIN_DEDUPE_USER_CHARS
    ) {
      const key = normalizeForDedupe(msg['content'] as string);
      if (seen.has(key)) continue; // later duplicate — drop from the summariser input
      seen.add(key);
    }
    out.push(m);
  }
  return out;
}

function buildCompactionUserTurn(messages: unknown[]): string {
  const serialised = dedupeUserMessagesForCompaction(messages)
    .map((m) => {
      const msg = m as Record<string, unknown>;
      const role = String(msg['role'] ?? 'unknown').toUpperCase();
      const content =
        typeof msg['content'] === 'string' ? msg['content'] : JSON.stringify(msg['content']);
      return `[${role}]\n${content}`;
    })
    .join('\n\n---\n\n');

  return `Please summarise the following conversation:\n\n${serialised}`;
}

/** Validate that a summary contains all five required sections. */
function isValidSummary(summary: string): boolean {
  for (const section of REQUIRED_SECTIONS) {
    if (!summary.includes(section)) {
      log.warn({ missingSections: section }, 'Compaction summary missing required section');
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compact a conversation into a structured five-section summary.
 *
 * Sends the full message history to the LLM with a strict summarisation
 * prompt. Validates that all five required sections are present; if not,
 * retries up to {@link MAX_COMPACTION_RETRIES} times before throwing.
 *
 * @param brain    - A brain-like object with a `call` method.
 * @param messages - Full conversation message history to summarise.
 * @returns The validated compaction summary string (max 16 000 chars).
 * @throws {PipelineError} When all retry attempts produce invalid summaries.
 */
export async function compact(brain: unknown, messages: unknown[]): Promise<string> {
  if (!brain || typeof (brain as BrainLike).call !== 'function') {
    throw new PipelineError(
      'compact: brain must be an object with a call() method',
      'pipeline_invalid_brain',
    );
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new PipelineError(
      'compact: messages must be a non-empty array',
      'pipeline_invalid_messages',
    );
  }

  const brainLike = brain as BrainLike;
  const systemPrompt = buildCompactionSystemPrompt();
  const userContent = buildCompactionUserTurn(messages);

  log.info({ messageCount: messages.length }, 'Starting context compaction');

  let lastSummary = '';

  for (let attempt = 1; attempt <= MAX_COMPACTION_RETRIES; attempt++) {
    log.debug({ attempt, maxRetries: MAX_COMPACTION_RETRIES }, 'Compaction attempt');

    try {
      // tier: 'high-stakes' — context compaction is one-shot per fill, and a
      // malformed summary loses state every subsequent turn depends on. Opts
      // into the env-driven strategy upgrade from PR #242.
      const response = await brainLike.call(
        {
          messages: [
            { role: 'system' as const, content: systemPrompt },
            { role: 'user' as const, content: userContent },
          ],
          temperature: 0.2,
          maxTokens: 4_096,
        },
        { tier: 'high-stakes' },
      );

      const summary = response.content?.trim() ?? '';

      if (!summary) {
        log.warn({ attempt }, 'Compaction returned empty summary — retrying');
        continue;
      }

      if (!isValidSummary(summary)) {
        if (attempt < MAX_COMPACTION_RETRIES) {
          log.warn({ attempt }, 'Compaction summary missing required sections — retrying');
          lastSummary = summary;
          continue;
        }
        // On final attempt: accept imperfect summary rather than failing the whole session
        log.warn({ attempt }, 'Compaction summary incomplete but accepting on final attempt');
      }

      // Enforce character limit.
      const final =
        summary.length > MAX_COMPACTION_CHARS
          ? summary.slice(0, MAX_COMPACTION_CHARS) + '\n\n[summary truncated]'
          : summary;

      log.info(
        { attempt, summaryLength: final.length, messageCount: messages.length },
        'Compaction completed successfully',
      );

      return final;
    } catch (err) {
      log.error({ attempt, err }, 'Compaction LLM call failed');
      if (attempt === MAX_COMPACTION_RETRIES) {
        throw new PipelineError(
          `Compaction failed after ${MAX_COMPACTION_RETRIES} attempts: ${String(err)}`,
          'pipeline_compaction_failed',
          { attempts: MAX_COMPACTION_RETRIES, lastError: String(err) },
        );
      }
    }
  }

  throw new PipelineError(
    `Compaction produced invalid summaries after ${MAX_COMPACTION_RETRIES} attempts`,
    'pipeline_compaction_invalid',
    {
      attempts: MAX_COMPACTION_RETRIES,
      requiredSections: REQUIRED_SECTIONS,
      lastSummarySnippet: lastSummary.slice(0, 200),
    },
  );
}

// ---------------------------------------------------------------------------
// MicroCompact — zero API cost local trimming
// ---------------------------------------------------------------------------
export function microCompact(history: string[], maxChars: number): string[] {
  const total = history.reduce((s, m) => s + m.length, 0);
  if (total <= maxChars) return history;
  if (history.length <= 10) return history;
  const head = history.slice(0, 2);
  const tail = history.slice(-8);
  const middle = history.slice(2, -8).map(m => m.length > 200 ? m.slice(0, 200) + '…[trimmed]' : m);
  return [...head, ...middle, ...tail];
}

// ---------------------------------------------------------------------------
// AutoCompact — triggered near token limit
// ---------------------------------------------------------------------------
/** Mutable failure counter wrapper — caller owns lifetime + scoping. */
export interface AutoCompactFailureCounter {
  count: number;
}

export interface AutoCompactOptions {
  reserveTokens?: number;
  maxSummaryTokens?: number;
  maxFailures?: number;
  /**
   * Optional per-caller circuit-breaker counter. When provided, autoCompact
   * reads and mutates THIS counter instead of the module-level default. Lets
   * callers scope the breaker (e.g., per session) so one misbehaving session
   * doesn't disable autoCompact for unrelated sessions in the same process.
   */
  failureCounter?: AutoCompactFailureCounter;
}

/**
 * Module-level fallback counter for standalone callers that don't pass
 * `failureCounter`. Shared across calls — known footgun in multi-session
 * processes; pass a `failureCounter` to scope per call site.
 */
const _defaultFailureCounter: AutoCompactFailureCounter = { count: 0 };

/**
 * Reset the module-level autoCompact circuit-breaker counter.
 * ONLY affects callers that did NOT pass their own `failureCounter`. Intended
 * for tests that drive the default counter to failure and need a clean slate.
 */
export function resetAutoCompactFailures(): void {
  _defaultFailureCounter.count = 0;
}

export async function autoCompact(
  history: Array<{ role: string; content: string }>,
  brain: {
    call(
      request: { messages: Array<{ role: string; content: string }>; maxTokens?: number; source?: string },
      opts?: { tier?: 'fast' | 'routine' | 'high-stakes' },
    ): Promise<{ content: string }>;
  },
  currentTokens: number,
  tokenLimit: number,
  options: AutoCompactOptions = {},
): Promise<{ history: Array<{ role: string; content: string }>; compacted: boolean; tokensAfter: number }> {
  const { reserveTokens = 13000, maxSummaryTokens = 20000, maxFailures = 3 } = options;
  const counter = options.failureCounter ?? _defaultFailureCounter;

  if (currentTokens <= tokenLimit - reserveTokens) {
    return { history, compacted: false, tokensAfter: currentTokens };
  }
  if (counter.count >= maxFailures) {
    return { history, compacted: false, tokensAfter: currentTokens };
  }

  try {
    const head = history.slice(0, 2);
    const tail = history.slice(-6);
    const middle = history.slice(2, -6);
    const middleText = middle.map(m => `${m.role}: ${m.content}`).join('\n\n');

    const summary = await brain.call(
      {
        source: 'compaction',
        messages: [
          { role: 'user', content: `Summarize this conversation history concisely, preserving all important context, decisions, and state:\n\n${middleText}` },
        ],
        maxTokens: maxSummaryTokens,
      },
      { tier: 'high-stakes' },
    );

    counter.count = 0;
    const compacted = [
      ...head,
      { role: 'system' as const, content: `[AutoCompact summary]\n${summary.content}` },
      ...tail,
    ];
    const charsAfter = compacted.reduce((s, m) => s + m.content.length, 0);
    return { history: compacted, compacted: true, tokensAfter: Math.round(charsAfter / 4) };
  } catch {
    counter.count++;
    return { history, compacted: false, tokensAfter: currentTokens };
  }
}

// ---------------------------------------------------------------------------
// FullCompact — nuclear reset
// ---------------------------------------------------------------------------
export async function fullCompact(
  history: Array<{ role: string; content: string }>,
  brain: {
    call(
      request: { messages: Array<{ role: string; content: string }>; maxTokens?: number; source?: string },
      opts?: { tier?: 'fast' | 'routine' | 'high-stakes' },
    ): Promise<{ content: string }>;
  },
  workspaceFiles: string[] = [],
): Promise<Array<{ role: string; content: string }>> {
  const allText = history.map(m => `${m.role}: ${m.content}`).join('\n\n');
  const lastUser = history.filter(m => m.role === 'user').at(-1);

  const summary = await brain.call(
    {
      source: 'compaction',
      messages: [{ role: 'user', content: `Create a dense summary of this entire conversation, capturing all decisions, context, state, and important details:\n\n${allText}` }],
      maxTokens: 16000,
    },
    { tier: 'high-stakes' },
  );

  const fileContext = workspaceFiles
    .slice(0, 3)
    .map(f => f.slice(0, 5000))
    .join('\n\n---\n\n');

  const systemContent = [
    '[FullCompact — conversation reset]',
    summary.content,
    fileContext ? `\n\n[Workspace context]\n${fileContext}` : '',
  ].filter(Boolean).join('\n\n');

  const result: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemContent },
  ];
  if (lastUser) result.push(lastUser);
  return result;
}
