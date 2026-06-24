/**
 * @file injection-scanner.ts
 * @description Memory injection scanner for SUDO-AI v5.
 *
 * Scans every memory write for prompt-injection patterns before storage.
 * Ported from Hermes's memory_tool.py `_MEMORY_THREAT_PATTERNS` pattern set.
 *
 * Scan modes (env SUDO_MEMORY_SCAN_MODE):
 *   strict    — reject any content that matches a threat pattern (default)
 *   sanitize  — strip matched segments, log a warning, store cleaned text
 *   off       — bypass all scanning (legacy compat only)
 *
 * All functions are synchronous — safe for use in better-sqlite3 call sites.
 */

import { createLogger } from '../shared/logger.js';
import { MemoryError } from '../shared/errors.js';
import type { HookManager } from '../hooks/index.js';

const log = createLogger('memory:injection-scanner');

// ---------------------------------------------------------------------------
// Module-level optional hook emitter (set by app bootstrap)
// ---------------------------------------------------------------------------

let _hookManager: HookManager | null = null;

/**
 * Register a HookManager so the scanner can emit `memory:scan:triggered`.
 * Call once at app bootstrap. Safe to call multiple times (last wins).
 */
export function setHookManager(hm: HookManager): void {
  _hookManager = hm;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by assertMemorySafe() when content contains injection patterns.
 * code: 'memory_injection'
 * details.reasons: list of matched pattern names
 */
export class MemoryInjectionError extends MemoryError {
  constructor(reasons: string[]) {
    super(
      `Memory injection detected. Matched patterns: ${reasons.join('; ')}`,
      'memory_injection',
      { reasons },
    );
    Object.setPrototypeOf(this, new.target.prototype);
    // Set name post-construction — avoids TS literal-type conflict with the base class
    // readonly declaration. Cast through unknown to bypass read-only check.
    (this as unknown as { name: string }).name = 'MemoryInjectionError';
  }
}

// ---------------------------------------------------------------------------
// Threat pattern registry
// ---------------------------------------------------------------------------

interface ThreatPattern {
  name: string;
  pattern: RegExp;
}

/**
 * MEMORY_THREAT_PATTERNS — compiled regex set covering known prompt-injection
 * and exfiltration attack vectors.
 */
export const MEMORY_THREAT_PATTERNS: readonly ThreatPattern[] = Object.freeze([
  // 1. Classic "ignore instructions" variants
  {
    name: 'ignore_instructions',
    pattern: /ignore\s+(previous|above|prior|all\s+previous)\s+instructions?/i,
  },
  // 2. System prompt override attempts
  {
    name: 'system_prompt_override',
    pattern: /system\s+prompt\s+(override|injection|replace|substitut)/i,
  },
  // 3. Role reassignment ("you are now", "act as", "pretend to be")
  {
    name: 'role_reassignment',
    pattern: /\b(you\s+are\s+now|act\s+as\s+an?\s+|pretend\s+to\s+be\s+|roleplay\s+as\s+)/i,
  },
  // 4. Disregard / bypass directives
  {
    name: 'disregard_directive',
    pattern: /\b(disregard|bypass|circumvent|override)\s+(your\s+)?(instructions?|rules?|guidelines?|constraints?|safety|ethics)/i,
  },
  // 5. Jailbreak keyword
  {
    name: 'jailbreak',
    pattern: /\bjailbreak\b/i,
  },
  // 6. Hidden zero-width unicode (zero-width space, joiner, non-joiner, word-joiner, BOM)
  {
    name: 'hidden_unicode',
    pattern: /[\u200B-\u200D\u2060\uFEFF]/,
  },
  // 7. ANSI escape sequences
  {
    name: 'ansi_escape',
    pattern: /\x1B\[[0-9;]*[A-Za-z]/,
  },
  // 8. Prompt-injection homoglyphs — Cyrillic lookalikes for Latin letters
  //    Covers: а е і о р с у х (Cyrillic) commonly used to spoof ASCII
  {
    name: 'homoglyph_cyrillic',
    pattern: /[\u0430\u0435\u0456\u043E\u0440\u0441\u0443\u0445]/,
  },
  // 9. Shell exfiltration markers (curl, wget, bash pipe)
  {
    name: 'exfil_shell',
    pattern: /\b(curl|wget)\s+https?:\/\/|bash\s+-[ci]\s+/i,
  },
  // 10. Base64 decode payload execution
  {
    name: 'base64_decode_exec',
    pattern: /base64\s+-d\b|base64\s+--decode\b|atob\s*\(/i,
  },
  // 11. eval() code execution
  {
    name: 'eval_exec',
    pattern: /\beval\s*\(/i,
  },
  // 12. URL to external host (non-relative, non-localhost HTTP/S URLs)
  //     Designed to catch data exfiltration callbacks and SSRF attempts.
  {
    name: 'external_url',
    pattern: /https?:\/\/(?!localhost|127\.0\.0\.1|::1)[\w.-]+\.[a-z]{2,}/i,
  },
  // 13. Prompt delimiter injection (common in structured prompts)
  {
    name: 'prompt_delimiter',
    pattern: /<\/?(?:system|user|assistant|human|ai|prompt|instruction)\b/i,
  },
  // 14. DAN / Do Anything Now variants
  {
    name: 'dan_prompt',
    pattern: /\b(DAN|do\s+anything\s+now)\b/,
  },
]);

// ---------------------------------------------------------------------------
// Scan result type
// ---------------------------------------------------------------------------

export interface ScanResult {
  /** True when no threat patterns matched. */
  clean: boolean;
  /** List of matched pattern names. Empty when clean. */
  reasons: string[];
  /**
   * Sanitized text with matched segments stripped.
   * Only present when called from sanitize mode.
   */
  sanitized?: string;
}

// ---------------------------------------------------------------------------
// Role-scoped pattern filtering
// ---------------------------------------------------------------------------

/**
 * Message source roles for scan context.
 * - 'user'      — untrusted user input; full pattern set applied.
 * - 'assistant' — the model's own generated reply; URL patterns skipped.
 * - 'system'    — system prompt text; URL patterns skipped (our own text).
 * - 'tool'      — external tool output (browser.search etc.); URL patterns skipped.
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Patterns that are only meaningful for untrusted (user-originated) content.
 *
 * `external_url` fires on any HTTP/S URL — which is entirely normal in
 * assistant replies (e.g. citing sources), system messages, and tool outputs
 * (e.g. browser.search / browser.fetch results that legitimately return URLs).
 * Applying it to system-generated content causes every URL-bearing message to
 * be rejected as a false positive. We skip it for assistant, system, and tool
 * roles while keeping full scanning for user messages (and undefined role for
 * backward compatibility).
 *
 * Defense rationale: `external_url` is a user-input-exfiltration guard. Only
 * `role === 'user'` (or undefined) originates from untrusted external parties.
 * Everything our own system produces is trusted to contain legitimate URLs.
 */
// UNTRUSTED_ONLY_PATTERNS: max 5 entries. Skip for role !== 'user' only if pattern is transcript-echo-safe (no active compromise indicator). Strict patterns must stay STRICT for all roles.
const UNTRUSTED_ONLY_PATTERNS = new Set<string>(['external_url', 'jailbreak', 'dan_prompt']);

// ---------------------------------------------------------------------------
// Core scan function
// ---------------------------------------------------------------------------

/**
 * Scan memory content for injection patterns.
 *
 * Always synchronous — safe inside better-sqlite3 call sites.
 *
 * @param text - Raw memory content to evaluate.
 * @param role - Optional message role. When 'assistant', 'tool', or 'system',
 *               URL-only patterns (external_url) are skipped because these roles
 *               legitimately contain external URLs (model replies, browser tool
 *               output, system messages). Full scanning applies for 'user' and
 *               undefined (backward compat). All other patterns still apply.
 * @returns ScanResult with clean flag, matched pattern names, and optional sanitized text.
 */
// NOTE (M-4 carry-over): Cross-chunk split injection (a threat pattern split across two
// separate memory writes) is architectural and cannot be detected per-write. Mitigation
// requires a sliding-window scan at retrieval time — out of scope for this scanner.

/**
 * Single-pass helper: run all patterns against a string, return matched names + sanitized.
 * Detection is performed on `normalized` (NFKC), while replacement targets the raw `working`
 * string so visible characters stay intact.
 * @internal
 */
function _singlePassScan(
  working: string,
  role?: MessageRole,
  context?: string,
): { newReasons: string[]; sanitized: string } {
  const normalized = working.normalize('NFKC');
  const newReasons: string[] = [];

  for (const { name, pattern } of MEMORY_THREAT_PATTERNS) {
    // Skip patterns that only apply to untrusted (user-originated) content.
    // 'external_url' is skipped for assistant, tool, and system roles — all
    // are system-generated and legitimately contain external URLs.
    // Only 'user' (and undefined role for backward compat) apply full scanning.
    if (
      (role === 'assistant' || role === 'tool' || role === 'system') &&
      UNTRUSTED_ONLY_PATTERNS.has(name)
    ) {
      log.debug({ context, patternName: name, role }, '[injection-scanner] role-scoped skip');
      continue;
    }
    if (pattern.test(normalized)) {
      newReasons.push(name);
    }
  }

  let sanitized = working;
  for (const { name, pattern } of MEMORY_THREAT_PATTERNS) {
    if (newReasons.includes(name)) {
      const globalPattern = new RegExp(
        pattern.source,
        pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
      );
      sanitized = sanitized.replace(globalPattern, '[REDACTED]');
    }
  }

  return { newReasons, sanitized };
}

export function scanMemoryContent(text: string, role?: MessageRole, context?: string): ScanResult {
  if (typeof text !== 'string') {
    return { clean: true, reasons: [] };
  }

  // M-2: Normalize to NFKC so fullwidth/homoglyph variants of attack patterns are detected.
  // Detection uses normalized text; sanitized output retains original visible characters.
  const normalized = text.normalize('NFKC');

  const reasons: string[] = [];

  for (const { name, pattern } of MEMORY_THREAT_PATTERNS) {
    // Skip patterns that only apply to untrusted (user-originated) content.
    // 'external_url' is skipped for assistant, tool, and system roles — all
    // are system-generated and legitimately contain external URLs.
    // Only 'user' (and undefined role for backward compat) apply full scanning.
    if (
      (role === 'assistant' || role === 'tool' || role === 'system') &&
      UNTRUSTED_ONLY_PATTERNS.has(name)
    ) {
      log.debug({ context, patternName: name, role }, '[injection-scanner] role-scoped skip');
      continue;
    }
    if (pattern.test(normalized)) {
      reasons.push(name);
    }
  }

  if (reasons.length === 0) {
    return { clean: true, reasons: [] };
  }

  // Build sanitized version (used in sanitize mode).
  // Use a global variant of each regex so ALL occurrences are stripped,
  // not just the first match — prevents repeated-injection bypass.
  // Note: replacement targets raw `text` to preserve original visible characters;
  // fullwidth variants that only NFKC-normalise to the pattern are flagged but may
  // not be stripped by replace() — strict mode is the primary defense.
  let sanitized = text;
  for (const { name, pattern } of MEMORY_THREAT_PATTERNS) {
    if (reasons.includes(name)) {
      const globalPattern = new RegExp(
        pattern.source,
        pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
      );
      sanitized = sanitized.replace(globalPattern, '[REDACTED]');
    }
  }

  // M-3: Re-scan sanitized output for stacked / residual payloads.
  // Loop up to 3 iterations; break early if clean.
  const allReasons = new Set(reasons);
  const MAX_RESCAN_ITERATIONS = 3;
  for (let i = 0; i < MAX_RESCAN_ITERATIONS; i++) {
    const { newReasons, sanitized: reSanitized } = _singlePassScan(sanitized, role, context);
    if (newReasons.length === 0) {
      break;
    }
    for (const r of newReasons) allReasons.add(r);
    sanitized = reSanitized;
  }

  return { clean: false, reasons: Array.from(allReasons), sanitized };
}

// ---------------------------------------------------------------------------
// assertMemorySafe
// ---------------------------------------------------------------------------

/**
 * Assert that memory content is free of injection patterns.
 *
 * @throws MemoryInjectionError listing all matched pattern names.
 */
export function assertMemorySafe(text: string, role?: MessageRole): void {
  const result = scanMemoryContent(text, role);
  if (!result.clean) {
    throw new MemoryInjectionError(result.reasons);
  }
}

// ---------------------------------------------------------------------------
// Mode-aware enforcement helper
// ---------------------------------------------------------------------------

type ScanMode = 'strict' | 'sanitize' | 'off';

function getScanMode(): ScanMode {
  const raw = process.env['SUDO_MEMORY_SCAN_MODE']?.toLowerCase().trim();
  if (raw === 'sanitize') return 'sanitize';
  if (raw === 'off') return 'off';
  return 'strict'; // default
}

/**
 * Mode-aware memory guard. Call this at every memory write site.
 *
 * - `strict` (default): throws MemoryInjectionError on any match.
 * - `sanitize`: returns cleaned text and logs a warning (never throws).
 * - `off`: returns text unchanged (legacy compat).
 *
 * Fires hook `memory:scan:triggered` (fire-and-forget) when a threat is found.
 *
 * @param text    - Raw content to guard.
 * @param context - Human-readable label for log messages (e.g. 'storeChunk').
 * @param role    - Message source role. When 'assistant', 'tool', or 'system',
 *                  URL-only patterns (external_url) are skipped because these
 *                  roles legitimately contain external URLs. Full scanning applies
 *                  for 'user' and undefined (backward compat).
 * @param modeOverride - Force a scan mode for this call, ignoring the global
 *                  SUDO_MEMORY_SCAN_MODE env. Used by the conversation-log writer
 *                  to sanitize (never throw) so a flagged tool result does not
 *                  abort persistence and drop the turn's final reply.
 * @returns The text to store — original when clean, sanitized text in sanitize mode.
 * @throws MemoryInjectionError in strict mode when patterns match.
 */
export function guardMemoryWrite(
  text: string,
  context = 'unknown',
  role?: MessageRole,
  modeOverride?: ScanMode,
): string {
  const mode = modeOverride ?? getScanMode();

  if (mode === 'off') {
    return text;
  }

  const result = scanMemoryContent(text, role, context);

  if (result.clean) {
    return text;
  }

  // Emit hook fire-and-forget (non-blocking — scanner stays synchronous)
  if (_hookManager) {
    _hookManager
      .emit('memory:scan:triggered', {
        event: 'memory:scan:triggered',
        meta: { reasons: result.reasons, rejected: mode === 'strict', context },
      })
      .catch((err: unknown) => {
        log.warn({ err: String(err) }, 'guardMemoryWrite: hook emit failed');
      });
  }

  if (mode === 'sanitize') {
    log.warn(
      { context, reasons: result.reasons, original: text.slice(0, 120) },
      'guardMemoryWrite: injection patterns stripped (sanitize mode)',
    );
    return result.sanitized ?? text;
  }

  // strict
  log.error(
    { context, reasons: result.reasons },
    'guardMemoryWrite: memory write rejected — injection patterns detected',
  );
  throw new MemoryInjectionError(result.reasons);
}
