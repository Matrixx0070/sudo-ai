/**
 * @file ansi.ts — ANSI / control-character stripping helper.
 *
 * Extracted from ToolCallCard.tsx so the pure function can be unit-tested
 * without pulling in the Ink/React import chain.
 *
 * Strips:
 *   - CSI sequences:  \x1b[ ... <final byte>   (SGR colour codes, cursor movement, etc.)
 *   - OSC sequences:  \x1b] ... BEL or ST       (hyperlinks, clipboard writes, etc.)
 *   - Charset shifts: \x1b( <letter>            (rarely seen, but present in some tools)
 *   - C0 controls:    0x00–0x08, 0x0B–0x1F, 0x7F (DEL)
 *                     (keeps \t=0x09, \n=0x0A, \r=0x0D)
 */

export const ANSI_STRIP_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|[\x00-\x08\x0B-\x1F\x7F]/g;

/**
 * Remove ANSI escape sequences and non-printable control characters (except \t \n \r)
 * from a string. Non-string input returns ''.
 */
export function stripAnsi(s: string): string {
  return typeof s === 'string' ? s.replace(ANSI_STRIP_RE, '') : '';
}
