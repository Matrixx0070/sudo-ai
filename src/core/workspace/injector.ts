/**
 * @file injector.ts
 * @description WorkspaceInjector — injects daily memory notes and long-term
 * memory into a session's message array at the start of each turn.
 *
 * Reads:
 *  - workspace/memory/YYYY-MM-DD.md  (today's log)
 *  - workspace/memory/YYYY-MM-DD.md  (yesterday's log)
 *  - workspace/MEMORY.md             (long-term memory, mainPeer only)
 *
 * All injected messages are prepended to session.messages so they appear
 * before any user messages in the context window.
 *
 * Idempotent: if today's note was already injected this session, returns
 * immediately without re-reading or re-injecting any files.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('workspace:injector');

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface WorkspaceInjectorConfig {
  /** Absolute path to the workspace directory (the folder containing memory/). */
  workspaceDir: string;
  /**
   * If set, workspace/MEMORY.md is only injected when session.peerId matches
   * this value.  When undefined, MEMORY.md is never injected.
   */
  mainPeerId?: string;
}

export interface WorkspaceInjectorDeps {
  config: WorkspaceInjectorConfig;
}

// ---------------------------------------------------------------------------
// Duck-typed SessionLike — matches the interface exported from loop-helpers.ts
// without creating a circular import.
// ---------------------------------------------------------------------------

interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: unknown[];
  toolCallId?: string;
  toolName?: string;
}

interface SessionLike {
  id: string;
  messages: SessionMessage[];
  channel?: string;
  peerId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the ISO date string (YYYY-MM-DD) for a given offset in days relative
 * to now.  offset=0 → today, offset=-1 → yesterday.
 */
function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Maximum characters injected per workspace file (~2.5k tokens).  Files
 * larger than this are tail-truncated — the most recent entries (appended at
 * the bottom) are kept, older ones dropped.  Prevents an unbounded daily log
 * or MEMORY.md from silently inflating the fixed token cost of every call.
 */
export const MAX_INJECT_CHARS = 10_000;

/**
 * Default cap for the daily-log sections (## Today / ## Yesterday, and the
 * system prompt's Recent Memory section which reads the same file): ~1k
 * tokens.  Daily logs accumulate all day (historically 7-22KB by evening);
 * only the newest entries matter for context.
 */
export const DAILY_INJECT_CHARS = 4_096;

/**
 * Resolve a positive-integer byte cap from an env var, falling back to the
 * given default on unset/empty/invalid values.  Read at call time so tests
 * (and the operator) can tune without a restart of the module graph.
 */
export function injectCap(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Tail-truncate content to MAX_INJECT_CHARS, keeping the end of the file
 * (newest entries) and cutting on a line boundary where possible.  Prepends
 * a marker so the model knows earlier content was omitted.
 */
export function truncateForInjection(content: string, maxChars: number = MAX_INJECT_CHARS): string {
  if (content.length <= maxChars) return content;
  let tail = content.slice(content.length - maxChars);
  const firstNewline = tail.indexOf('\n');
  if (firstNewline > 0 && firstNewline < maxChars / 10) {
    tail = tail.slice(firstNewline + 1);
  }
  return `[...truncated: older entries trimmed — showing most recent ${tail.length} of ${content.length} chars]\n${tail}`;
}

// ---------------------------------------------------------------------------
// BO3 / S2 — policy-digest truncation, missing-file markers, truncation warnings
//
// An over-budget rules file (AGENTS.md / SAFETY-RULES.md) that is blindly
// tail-chopped can drop a hard rule (`NEVER delete production data`). These
// helpers preserve the imperative/rule lines under heavy truncation, make an
// absent rules/identity file VISIBLE instead of silently skipped, and emit a
// deterministic in-band truncation warning. Every output here is a pure
// function of its input (no clock, no env read) so the byte-stable cacheable
// prefix (BO2b) stays byte-identical turn-over-turn.
// ---------------------------------------------------------------------------

/** Basename of a workspace file name (matches readWorkspaceFile's path-safety). */
function baseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/**
 * Workspace files whose ABSENCE must be visible (identity + hard-rules
 * backbone). A deleted one of these degrades the agent invisibly today;
 * assembleSystemPrompt injects a `[missing workspace file: NAME]` marker for
 * each instead of silently skipping it.
 */
export const IMPORTANT_WORKSPACE_FILES: ReadonlySet<string> = new Set([
  'SOUL.md',
  'IDENTITY.md',
  'AGENTS.md',
  'SAFETY-RULES.md',
]);

/**
 * Workspace files treated as POLICY/RULES: over-budget truncation of these must
 * preserve the imperative/hard-rule lines (policy digest) rather than blindly
 * tail-chopping and dropping a `NEVER …` rule.
 */
export const POLICY_WORKSPACE_FILES: ReadonlySet<string> = new Set([
  'AGENTS.md',
  'SAFETY-RULES.md',
  'GIT-SAFETY.md',
  'AUTONOMY.md',
  'THINKING-RULES.md',
  'PR-WORKFLOW.md',
  'CODING.md',
]);

/** Is `name` a policy/rules file (by explicit set or a RULES/SAFETY/AGENTS/POLICY name)? */
export function isPolicyFile(name: string): boolean {
  const base = baseName(name);
  if (POLICY_WORKSPACE_FILES.has(base)) return true;
  return /(?:^|[-_])(?:SAFETY|RULES?|AGENTS?|POLICY|GUARD(?:RAILS?)?)(?:[-_.]|$)/i.test(base);
}

/** Deterministic marker injected for an absent important workspace file. */
export function missingFileMarker(name: string): string {
  return `[missing workspace file: ${baseName(name)}]`;
}

/** Default cap for policy/rules-file injection (safety net; large so normal files pass through). */
export const RULES_INJECT_CHARS = 64_000;

/** Header prefixing the extracted policy digest inside a truncated rules block. */
export const POLICY_DIGEST_HEADER =
  '[policy digest — imperative/rule lines preserved verbatim; prose truncated to fit budget]';

/**
 * Decide whether a single line is a RULE line worth preserving under truncation:
 *  - bullet list item (`- ` / `* `)
 *  - numbered rule (`1.` / `1)`)
 *  - markdown section header (`#`..`######`)
 *  - a line carrying an UPPERCASE imperative keyword (MUST / NEVER / ALWAYS / …).
 * Prose paragraphs match none of these and are dropped from the digest.
 */
export function isRuleLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[-*]\s+\S/.test(t)) return true; // bullet
  if (/^\d+[.)]\s+\S/.test(t)) return true; // numbered
  if (/^#{1,6}\s+\S/.test(t)) return true; // header
  // UPPERCASE imperative keyword anywhere on the line.
  if (/\b(?:MUST NOT|MUST|NEVER|ALWAYS|SHALL NOT|SHALL|DO NOT|DON'T|FORBIDDEN|PROHIBITED|REQUIRED)\b/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Extract the policy digest — the imperative/rule lines — from a document,
 * preserving each line VERBATIM and in document order. Prose is dropped.
 */
export function extractPolicyDigest(content: string): string {
  const kept: string[] = [];
  for (const line of content.split('\n')) {
    if (isRuleLine(line)) kept.push(line);
  }
  return kept.join('\n');
}

/** Tail-keep on a line boundary, WITHOUT any marker (the warning is emitted separately). */
function tailKeepOnLineBoundary(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  let tail = content.slice(content.length - maxChars);
  const nl = tail.indexOf('\n');
  if (nl > 0 && nl < maxChars / 10) tail = tail.slice(nl + 1);
  return tail;
}

export interface PolicyTruncationResult {
  /** Body to inject (digest-first when truncated). */
  text: string;
  /** True when the input exceeded maxChars and was truncated. */
  truncated: boolean;
  /** Original character length of the input. */
  originalChars: number;
}

/**
 * Truncate a POLICY/RULES file so the hard rules survive. Regex-extracted policy
 * digest (rule lines) is emitted VERBATIM first — hard rules are non-negotiable
 * and are never dropped, even when the digest alone exceeds the budget — then a
 * head/tail split keeps the most-recent prose excerpt that still fits.
 * Deterministic: same input → same output (byte-stable-prefix safe).
 */
export function truncatePolicyForInjection(
  content: string,
  maxChars: number = RULES_INJECT_CHARS,
): PolicyTruncationResult {
  const originalChars = content.length;
  if (originalChars <= maxChars) return { text: content, truncated: false, originalChars };

  const digest = extractPolicyDigest(content);
  if (!digest) {
    // No identifiable rule lines — nothing to preserve; plain tail truncation.
    return { text: truncateForInjection(content, maxChars), truncated: true, originalChars };
  }

  const digestBlock = `${POLICY_DIGEST_HEADER}\n${digest}`;
  const remaining = maxChars - digestBlock.length - 2;
  let text: string;
  if (remaining > 80) {
    const excerpt = tailKeepOnLineBoundary(content, remaining);
    text = `${digestBlock}\n\n[...prose truncated — most-recent excerpt follows...]\n${excerpt}`;
  } else {
    // Digest fills (or exceeds) the budget — keep the full digest; hard rules win.
    text = digestBlock;
  }
  return { text, truncated: true, originalChars };
}

/** Deterministic in-band truncation warning line for a truncated file. */
export function truncationWarning(name: string, keptChars: number): string {
  return `[truncation warning: ${baseName(name)} cut to ${keptChars} chars]`;
}

/** Dedupe a list of warning lines, preserving first-seen order. */
export function dedupeWarningLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

export interface PreparedRulesFile {
  /** Policy-aware body to inject (no warning line). Empty when content is empty. */
  body: string;
  /** Deterministic warning line, or '' when the file was not truncated. */
  warning: string;
  /** Whether the file was truncated. */
  truncated: boolean;
}

/**
 * Prepare a policy/rules file for injection: apply policy-digest truncation and,
 * when truncated, produce a single deterministic in-band truncation warning
 * (the caller dedupes across files). `content` may already be a
 * `[missing workspace file: …]` marker — returned untouched, never truncated.
 */
export function prepareRulesFile(
  name: string,
  content: string,
  maxChars: number = RULES_INJECT_CHARS,
): PreparedRulesFile {
  if (!content) return { body: '', warning: '', truncated: false };
  if (content.startsWith('[missing workspace file:')) {
    return { body: content, warning: '', truncated: false };
  }
  const r = truncatePolicyForInjection(content, maxChars);
  const warning = r.truncated ? truncationWarning(name, r.text.length) : '';
  return { body: r.text, warning, truncated: r.truncated };
}

/**
 * Attempt to read a file at the given absolute path.
 * Returns the trimmed content string (tail-truncated to MAX_INJECT_CHARS),
 * or null if the file does not exist or any read error occurs. Never throws.
 */
async function tryReadFile(filePath: string, maxChars: number = MAX_INJECT_CHARS): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const trimmed = content.trim();
    return trimmed ? truncateForInjection(trimmed, maxChars) : null;
  } catch {
    // File missing or unreadable — silently skip.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Inject workspace context (daily memory notes + long-term MEMORY.md) into
 * the front of `session.messages`.
 *
 * Idempotency: checks whether a system message starting with '## Today\n' is
 * already present.  If found, returns immediately — safe to call multiple
 * times per session without duplicating context.
 *
 * @param session - The active agent session (duck-typed).
 * @param deps    - Injector dependencies (config with workspaceDir / mainPeerId).
 */
export async function injectWorkspaceContext(
  session: SessionLike,
  deps: WorkspaceInjectorDeps,
): Promise<void> {
  const { config } = deps;

  if (!config.workspaceDir || typeof config.workspaceDir !== 'string') {
    log.warn({ sessionId: session.id }, 'injectWorkspaceContext: workspaceDir is empty — skipping');
    return;
  }

  // --- Idempotency check ------------------------------------------------
  // If workspace context was already injected (from a previous call this
  // session), bail out immediately to avoid duplicating context.  We match any
  // of the section markers we emit — not just '## Today\n' — because today's
  // log may be absent while yesterday's log or MEMORY.md were still injected.
  // Keying only off the '## Today\n' marker would fail to detect those cases
  // and re-inject them on every subsequent call.
  const alreadyInjected = session.messages.some(
    (m) =>
      m.role === 'system' &&
      typeof m.content === 'string' &&
      (m.content.startsWith('## Today\n') ||
        m.content.startsWith('## Yesterday\n') ||
        m.content.startsWith('## Long-Term Memory\n')),
  );
  if (alreadyInjected) {
    log.debug({ sessionId: session.id }, 'injectWorkspaceContext: already injected — skipping');
    return;
  }

  log.debug({ sessionId: session.id, workspaceDir: config.workspaceDir }, 'Injecting workspace context');

  const memoryDir = path.join(config.workspaceDir, 'memory');

  // Collect messages to prepend (built up in reverse insertion order because
  // we unshift each one; the final order in session.messages will be:
  //   [MEMORY.md] [yesterday] [today] [... existing messages ...]
  // We build the list in natural order then reverse-unshift so MEMORY.md ends
  // up first, giving the brain the clearest reading order.

  const toInject: SessionMessage[] = [];

  // Per-section byte caps (env-tunable; SUDO_INJECT_TODAY_MAX for the daily
  // logs, SUDO_INJECT_MEMORY_MAX for long-term MEMORY.md). Tail-kept: newest
  // entries survive, oldest are trimmed with a marker line.
  const dailyCap = injectCap('SUDO_INJECT_TODAY_MAX', DAILY_INJECT_CHARS);
  const memoryCap = injectCap('SUDO_INJECT_MEMORY_MAX', MAX_INJECT_CHARS);

  // 1. Today's daily log — memory/YYYY-MM-DD.md
  const todayPath = path.join(memoryDir, `${isoDate(0)}.md`);
  const todayContent = await tryReadFile(todayPath, dailyCap);
  if (todayContent) {
    toInject.push({ role: 'system', content: `## Today\n${todayContent}` });
    log.debug({ sessionId: session.id, path: todayPath }, 'Today memory injected');
  }

  // 2. Yesterday's daily log — memory/YYYY-MM-DD.md (offset -1)
  const yesterdayPath = path.join(memoryDir, `${isoDate(-1)}.md`);
  const yesterdayContent = await tryReadFile(yesterdayPath, dailyCap);
  if (yesterdayContent) {
    toInject.push({ role: 'system', content: `## Yesterday\n${yesterdayContent}` });
    log.debug({ sessionId: session.id, path: yesterdayPath }, 'Yesterday memory injected');
  }

  // 3. Long-term MEMORY.md — only when session.peerId matches mainPeerId
  if (config.mainPeerId !== undefined && session.peerId === config.mainPeerId) {
    const memoryFilePath = path.join(config.workspaceDir, 'MEMORY.md');
    const memoryContent = await tryReadFile(memoryFilePath, memoryCap);
    if (memoryContent) {
      toInject.push({ role: 'system', content: `## Long-Term Memory\n${memoryContent}` });
      log.debug({ sessionId: session.id, path: memoryFilePath }, 'Long-term MEMORY.md injected');
    }
  }

  if (toInject.length === 0) {
    log.debug({ sessionId: session.id }, 'injectWorkspaceContext: no memory files found — nothing injected');
    return;
  }

  // Prepend messages in reverse order so that after unshifting, the array
  // reads: [today, yesterday, MEMORY.md (if any), ...existing messages]
  // We want today first because the idempotency marker is on today's note.
  // Reverse the collected list then unshift each entry so the final order is
  // the same as the order in toInject (index 0 ends up at position 0).
  for (let i = toInject.length - 1; i >= 0; i--) {
    session.messages.unshift(toInject[i] as SessionMessage);
  }

  log.info(
    { sessionId: session.id, injectedCount: toInject.length },
    'Workspace context injected',
  );
}
