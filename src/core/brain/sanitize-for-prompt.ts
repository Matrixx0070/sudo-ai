/**
 * Prompt-literal sanitization (Beat-OpenClaw BO5 / roadmap S11).
 *
 * WHAT THIS IS FOR
 * ----------------
 * Every time an *interpolated identifier* — a workspace path, a peer name, a
 * session key, a directory or file name, an agent name, a channel id, or a
 * remote-MCP tool name/description — is spliced into an assembled prompt or a
 * `role:'system'` message, it becomes a literal inside a document that the
 * model reads as authoritative instructions. If that literal can carry
 * Unicode control/format characters, bidi overrides, zero-width joiners, or a
 * raw newline, an attacker who controls the identifier (a malicious directory
 * name, a hostile MCP server's tool name, a crafted peer handle) can:
 *
 *   - inject an invisible bidi override that visually reorders surrounding
 *     text (the classic "Trojan Source" attack), or
 *   - smuggle zero-width joiners that defeat naive string matching, or
 *   - break out of the literal's line with `"\n\nSYSTEM: ignore all previous
 *     instructions"` so the injection appears as a brand-new, line-anchored
 *     directive in the prompt.
 *
 * `sanitizeForPrompt` is the single, deterministic chokepoint that neutralises
 * all three. It mirrors OpenClaw's `sanitize-for-prompt.ts`, which strips
 * Unicode control/format characters from paths and session names before they
 * enter the prompt.
 *
 * SCOPE — READ THIS BEFORE REUSING
 * --------------------------------
 * This function is for INTERPOLATED LITERALS / IDENTIFIERS, **not** for the
 * user's message body or for external CONTENT returned from a tool. Those are
 * governed by F18 quarantine (`inspectContent`) and the zone classifier;
 * running this over conversational text would corrupt legitimately non-ASCII
 * messages (a newline in the user's prose is meaningful, a soft hyphen in a
 * German word is meaningful). This ADDS a defensive layer for identifiers; it
 * does not replace quarantine, zone checks, or any existing security gate.
 *
 * WHAT IT STRIPS
 * --------------
 *   - C0 control chars U+0000–U+001F (this INCLUDES tab, CR and LF) and
 *     DEL U+007F — matched by \p{Cc}.
 *   - C1 control chars U+0080–U+009F — also \p{Cc}.
 *   - Unicode format chars \p{Cf}. This covers, non-exhaustively: the
 *     zero-width set (ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D), the bidi marks
 *     and overrides (LRM/RLM U+200E/F, LRE/RLE/PDF/LRO/RLO U+202A–U+202E),
 *     the bidi isolates (LRI/RLI/FSI/PDI U+2066–U+2069), the invisible math
 *     operators U+2060–U+2064, the BOM / ZWNBSP U+FEFF, the SOFT HYPHEN
 *     U+00AD, MONGOLIAN VOWEL SEPARATOR U+180E, and the interlinear
 *     annotation anchors U+FFF9–U+FFFB.
 *   - Line separator U+2028 (\p{Zl}) and paragraph separator U+2029 (\p{Zp}).
 *
 * Because an identifier must live on a single line inside its literal position,
 * every one of these is REMOVED (replaced by nothing) rather than escaped. A
 * newline-injection payload therefore collapses onto one line — the smuggled
 * "SYSTEM:" text is glued to its neighbour and can never appear as a new
 * line-anchored directive.
 *
 * Ordinary whitespace (the regular space U+0020) and every printable
 * character — ASCII, accented Latin, CJK, emoji — are preserved untouched, so
 * legitimate paths and names survive intact.
 *
 * The result is length-capped (default 1024 chars) so a pathological
 * identifier cannot blow up the prompt.
 *
 * The function is pure, deterministic, and idempotent:
 * `sanitizeForPrompt(sanitizeForPrompt(s)) === sanitizeForPrompt(s)`.
 */

/** Default maximum length for a sanitized prompt literal. */
export const DEFAULT_PROMPT_LITERAL_MAX = 1024;

/**
 * Single regex matching every character class we strip from a prompt literal:
 *   \p{Cc} — C0/C1 control chars (includes \t \n \r \x7f)
 *   \p{Cf} — Unicode format chars (zero-width, bidi overrides/isolates, BOM, …)
 *   \p{Zl} — line separator U+2028
 *   \p{Zp} — paragraph separator U+2029
 *
 * Global + Unicode flags. Kept module-level and stateless-per-call by resetting
 * lastIndex is unnecessary because `String.prototype.replace` does not rely on
 * lastIndex for a global regex, but we avoid `.test`/`.exec` on this shared
 * instance for that reason.
 */
const STRIP_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export interface SanitizeForPromptOptions {
  /**
   * Maximum length of the returned string. Anything longer is truncated
   * (after stripping). Defaults to {@link DEFAULT_PROMPT_LITERAL_MAX}.
   */
  maxLength?: number;
}

/**
 * Strip Unicode control/format/bidi/zero-width/separator characters from an
 * interpolated prompt literal and cap its length.
 *
 * @param s - The raw identifier/literal to be spliced into a prompt. Non-string
 *   input (including `null`/`undefined`) returns an empty string — a
 *   sanitizer must never throw on the hot prompt-assembly path.
 * @param options - Optional length cap override.
 * @returns A single-line, control-free, length-capped string safe to
 *   interpolate into an assembled prompt or `role:'system'` message.
 */
export function sanitizeForPrompt(s: unknown, options: SanitizeForPromptOptions = {}): string {
  if (typeof s !== 'string' || s.length === 0) return '';

  const stripped = s.replace(STRIP_PATTERN, '');

  const maxLength = options.maxLength ?? DEFAULT_PROMPT_LITERAL_MAX;
  if (maxLength >= 0 && stripped.length > maxLength) {
    return stripped.slice(0, maxLength);
  }
  return stripped;
}
