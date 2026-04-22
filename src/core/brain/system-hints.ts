/**
 * @file system-hints.ts
 * @description Dynamic contextual guidance injected into the system prompt.
 *
 * Based on ChatGPT's hidden system_hints mechanism and Claude Code's
 * session-specific guidance blocks. Hints are condition-driven text
 * snippets that fire when the user message matches a pattern.
 *
 * Usage:
 *   const hints = getActiveHints(userMessage, context);
 *   // Pass hints to assembleSystemPrompt({ activeHints: hints })
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:system-hints');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single conditional guidance entry. */
export interface SystemHint {
  /** Unique stable identifier for this hint (for deduplication and logging). */
  id: string;
  /**
   * Predicate function — returns true when this hint should fire.
   *
   * @param message - The user's latest message (lowercased before testing).
   * @param context - Optional arbitrary context object from the call site.
   */
  condition: (message: string, context?: unknown) => boolean;
  /** Guidance text injected into the system prompt when condition is true. */
  hint: string;
  /**
   * Priority — higher number wins when hints must be truncated for token budget.
   * Range: 1–100 (10 = normal, 50 = important, 90 = critical).
   */
  priority: number;
}

// ---------------------------------------------------------------------------
// Built-in hints
// ---------------------------------------------------------------------------

const CODING_RE = /\b(code|bug|fix|implement|function|class|module|refactor|test|debug|compile|error\s+ts|typescript|javascript|python|rust|go|bash)\b/;
const RESEARCH_RE = /\b(research|find|search|latest|what is|who is|when did|explain|overview|summary|article)\b/;
const FILE_RE = /\b(file|folder|directory|read|write|create|delete|move|rename|list|glob|path)\b/;
const BROWSER_RE = /\b(browser|navigate|click|open|scrape|screenshot|website|page|url|download)\b/;
const SHELL_RE = /\b(run|execute|shell|terminal|command|install|npm|pnpm|apt|git|docker|process)\b/;
const ANALYSIS_RE = /\b(analys[ei]|compare|metrics|data|chart|stats|performance|benchmark|report)\b/;
const FRONTEND_RE = /\b(react|css|html|component|ui|frontend|layout|style|tailwind|next\.js)\b/i;
const GIT_SAFETY_RE = /\b(git|commit|push|merge|branch|rebase)\b/i;
const AUTONOMY_RE = /\b(fix|implement|build|create|add|update|change|modify|refactor)\b/i;

const HINTS: SystemHint[] = [
  {
    id: 'coding-task',
    condition: (msg) => CODING_RE.test(msg),
    hint:
      'CODING TASK DETECTED: Read existing code before modifying. ' +
      'Use coder tools for all file operations. ' +
      'After writing code, verify with a typecheck or lint tool. ' +
      'Never leave placeholder comments — write complete implementations.',
    priority: 10,
  },
  {
    id: 'research-task',
    condition: (msg) => RESEARCH_RE.test(msg),
    hint:
      'RESEARCH TASK DETECTED: Use web.search or browser tools first. ' +
      'Cite sources explicitly. Cross-check at least 2 sources before concluding. ' +
      'Prefer recent information (check publication dates). Be thorough, not superficial.',
    priority: 10,
  },
  {
    id: 'file-operation',
    condition: (msg) => FILE_RE.test(msg),
    hint:
      'FILE OPERATION DETECTED: Always verify the path exists before writing. ' +
      'Use coder.file-read before coder.file-write to avoid clobbering. ' +
      'For bulk operations, list the directory first to understand the structure.',
    priority: 8,
  },
  {
    id: 'browser-task',
    condition: (msg) => BROWSER_RE.test(msg),
    hint:
      'BROWSER TASK DETECTED: Follow the mandatory 4-step protocol — ' +
      'screenshot → snapshot → interact → screenshot confirm. ' +
      'Always extract selectors from the ARIA snapshot, never guess them.',
    priority: 10,
  },
  {
    id: 'shell-task',
    condition: (msg) => SHELL_RE.test(msg),
    hint:
      'SHELL TASK DETECTED: Prefer non-destructive commands. ' +
      'Always capture stdout and stderr. ' +
      'For long-running processes, check if a background mode is available. ' +
      'Never run rm -rf without explicit user confirmation.',
    priority: 12,
  },
  {
    id: 'analysis-task',
    condition: (msg) => ANALYSIS_RE.test(msg),
    hint:
      'ANALYSIS TASK DETECTED: Structure your analysis with clear sections. ' +
      'Back claims with data. Distinguish findings from recommendations. ' +
      'Quantify where possible — avoid vague qualitative-only answers.',
    priority: 8,
  },
  {
    id: 'tool-preferences',
    condition: () => true, // Always active
    hint:
      'Prefer dedicated tools over shell commands: use file-read not cat, file-write not echo, ' +
      'web-search not curl. Reserve shell exec for operations with no dedicated tool.',
    priority: 20,
  },
  {
    id: 'parallel-tools',
    condition: () => true, // Always active
    hint:
      'Call multiple independent tools in parallel. Only sequence tools that depend on each other.',
    priority: 15,
  },
  // Upgrade 23: Codex GPT-5.4 derived hints
  {
    id: 'frontend-task',
    condition: (msg) => FRONTEND_RE.test(msg),
    hint:
      'For frontend tasks: prefer established patterns from the existing codebase. ' +
      'Match the existing component style. Use the project CSS framework. ' +
      'Test visually if browser tools are available.',
    priority: 12,
  },
  {
    id: 'git-safety',
    condition: (msg) => GIT_SAFETY_RE.test(msg),
    hint:
      'Git safety: NEVER force-push to main. NEVER amend published commits. ' +
      'NEVER skip hooks. ALWAYS create NEW commits. Stage specific files, not git add -A.',
    priority: 18,
  },
  {
    id: 'autonomy-reminder',
    condition: (msg) => AUTONOMY_RE.test(msg),
    hint:
      'Do not stop at analysis or planning. Implement the change, verify it works, ' +
      'then explain what you did. Persist until the task is fully complete.',
    priority: 20,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the hint strings that are active for the given message.
 *
 * Filters HINTS whose condition matches, sorts by descending priority,
 * and returns the hint text strings.
 *
 * @param message - The user's latest message.
 * @param context - Optional context (passed through to condition functions).
 * @returns Ordered array of hint strings (highest priority first).
 */
export function getActiveHints(message: string, context?: unknown): string[] {
  if (!message || typeof message !== 'string') {
    log.warn({ message }, 'getActiveHints: invalid message — returning empty hints');
    return [];
  }

  const lower = message.toLowerCase();
  const active: SystemHint[] = [];

  for (const hint of HINTS) {
    try {
      if (hint.condition(lower, context)) {
        active.push(hint);
      }
    } catch (err) {
      log.warn({ hintId: hint.id, err: String(err) }, 'Hint condition threw — skipping');
    }
  }

  if (active.length === 0) return [];

  active.sort((a, b) => b.priority - a.priority);

  const result = active.map((h) => h.hint);
  log.debug({ count: result.length, ids: active.map((h) => h.id) }, 'Active hints resolved');
  return result;
}

/**
 * Register a custom runtime hint.
 *
 * Allows callers to inject project-specific guidance without modifying this file.
 *
 * @param hint - A fully-formed SystemHint object.
 */
export function registerHint(hint: SystemHint): void {
  if (!hint.id || !hint.hint || typeof hint.condition !== 'function') {
    log.warn({ hint }, 'registerHint: invalid hint — ignoring');
    return;
  }
  HINTS.push(hint);
  log.info({ hintId: hint.id, priority: hint.priority }, 'Custom hint registered');
}
