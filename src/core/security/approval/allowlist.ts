/**
 * Exec approval allowlist — determines which commands are safe to run
 * without human approval.
 *
 * Safety rules:
 * 1. Commands containing shell metacharacters (pipes, redirects, substitution,
 *    semicolons, logical operators) are NEVER allowlisted — they must go through
 *    the approval gate regardless of the base command name.
 * 2. Commands whose first token contains a '/' (absolute or relative path prefix)
 *    are NEVER allowlisted — they may point to malicious binaries.
 * 3. Multi-token allowlist entries (e.g. "git status") match on both the base
 *    command name AND its first argument.
 * 4. curl is special-cased: only silent GET-style invocations to non-private
 *    hosts are allowlisted (strict SSRF + exfil block).
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// Shell metacharacter detector — MUST be checked before any other logic
// ---------------------------------------------------------------------------

/**
 * Regex matching any shell metacharacter that could chain or redirect commands.
 * A command string matching this is NEVER allowlisted.
 */
const SHELL_METACHARS_RE = /[;|&`$><()\n\\]/;

/** Returns true if the command string contains any shell metacharacter. */
function hasShellMetachars(command: string): boolean {
  return SHELL_METACHARS_RE.test(command);
}

// ---------------------------------------------------------------------------
// Allowlist data
// ---------------------------------------------------------------------------

/**
 * Single-token commands that are always safe (informational/status only).
 * Matched against path.basename(firstToken).
 *
 * NOTE: cat, head, tail, grep, echo have been intentionally REMOVED.
 *   - cat/head/tail: `cat /etc/shadow` is a credential compromise.
 *   - grep: `grep -r password /` performs broad filesystem search.
 *   - echo: unnecessary and `echo $SECRET` can leak env vars.
 * Filesystem read allowlisting will be done with a path-scoped allowlist
 * in a future iteration.
 */
const SAFE_SINGLE_COMMANDS = new Set([
  'ls', 'pwd', 'cd', 'du',
  'ps', 'uptime', 'df', 'free', 'whoami', 'date', 'uname',
  // Spec 10 (textproc): read-only text-processing tools. Safe to run without
  // approval as a SINGLE command — any pipeline containing them has shell
  // metachars and is already rejected at Step 1, so this only auto-approves
  // one plain invocation (e.g. `rg pattern file`, `jq . data.json`).
  // Tools that can WRITE (sed -i, awk -i inplace, sponge, tee, sd) are handled
  // by TEXT_TOOLS_WITH_WRITE below with a flag scan — NOT listed here.
  'rg', 'ugrep', 'jq', 'gron', 'yq', 'dasel', 'xq', 'mlr', 'qsv',
  'csvlook', 'csvstat', 'csvcut', 'csvgrep', 'in2csv', 'datamash',
  'cut', 'sort', 'uniq', 'wc', 'nl', 'tac', 'rev', 'comm', 'paste',
  'join', 'fold', 'fmt', 'column', 'choose', 'htmlq', 'hxselect',
  'jless', 'fx', 'difft', 'delta', 'colordiff', 'sdiff', 'batcat', 'bat',
  'fd', 'fdfind', 'strings', 'file',
]);

/**
 * Text tools whose canonical form is read-only but which have an in-place /
 * write mode behind a flag. Auto-approved as a single command ONLY when the
 * write flag is absent; otherwise they fall through to the approval gate.
 */
const TEXT_TOOLS_WITH_WRITE = new Set(['sed', 'awk', 'gawk', 'perl']);

/**
 * Flags that turn a read tool into a writer. Matched against the whole
 * (metachar-free) command string. `sed -i`, `gawk -i inplace`, `perl -i`.
 */
const INPLACE_WRITE_RE = /(^|\s)-[a-zA-Z]*i(\s|=|\[|$)|(^|\s)--in-place\b|(^|\s)-i\s+inplace\b|inplace/i;

/**
 * Two-token pairs (cmd, firstArg) that are safe together.
 * Key: `${baseName} ${firstArg}` (both lowercased).
 *
 * NOTE: `git show` has been intentionally REMOVED — `git show HEAD:.env`
 * can read committed secrets directly.
 */
const SAFE_TWO_TOKEN_PAIRS = new Set([
  'git status',
  'git log',
  'git diff',
  'git branch',
  'npm --version',
  'npm list',
  'node --version',
]);

// ---------------------------------------------------------------------------
// curl SSRF + exfil guard
// ---------------------------------------------------------------------------

/**
 * Hosts (or hostname substrings) that are blocked in curl URLs.
 * Covers cloud metadata endpoints and local/loopback addresses.
 */
const BLOCKED_CURL_HOSTS = [
  '169.254.169.254',        // AWS/GCP/Azure IMDS
  'metadata.google.internal',
  'metadata.azure.com',
  '127.0.0.1',
  'localhost',
  '0.0.0.0',
  '::1',
];

/**
 * Blocked flag patterns matched against the full command string (case-insensitive).
 * Each entry is either a string literal to search for or a RegExp.
 */
type BlockedPattern = string | RegExp;

const BLOCKED_CURL_PATTERNS: BlockedPattern[] = [
  'file://',
  '--data-binary',
  '--data-raw',
  '--data-urlencode',
  /\s--data\b/i,      // --data (word boundary prevents matching --data-urlencode again)
  /\s-d\s/,           // -d <value> (trailing space guards against -dSOMETHING)
  '-F ',              // -F / --form (multipart)
  '--form ',
  '-T ',              // -T / --upload-file (upload)
  '--upload-file ',
  '-K ',              // -K / --config
  '--config ',
  '@/',               // file reference param (e.g. @/etc/passwd)
  // Non-GET HTTP methods (exact case-insensitive flag words)
  /\B-X\s+(POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/i,
  /--request\s+(POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/i,
];

/**
 * Converts an IPv6 hex-pair representation (e.g. "a9fe:a9fe") to
 * dotted-decimal IPv4 (e.g. "169.254.169.254").
 * Returns null if the input is not exactly two colon-separated hex words.
 */
function hexPairsToDotted(s: string): string | null {
  const parts = s.split(':');
  if (parts.length !== 2) return null;
  try {
    const n1 = parseInt(parts[0]!, 16);
    const n2 = parseInt(parts[1]!, 16);
    if (
      !Number.isFinite(n1) || !Number.isFinite(n2) ||
      n1 < 0 || n1 > 0xffff || n2 < 0 || n2 > 0xffff
    ) return null;
    const b1 = (n1 >> 8) & 0xff;
    const b2 = n1 & 0xff;
    const b3 = (n2 >> 8) & 0xff;
    const b4 = n2 & 0xff;
    return `${b1}.${b2}.${b3}.${b4}`;
  } catch {
    return null;
  }
}

/**
 * Returns true if the given hostname is on the blocked list.
 * Handles:
 *   - IPv6 bracket notation ([::1] → ::1)
 *   - IPv6 loopback, unspecified, link-local, unique-local
 *   - IPv4-mapped IPv6 (::ffff:169.254.169.254 or ::ffff:a9fe:a9fe)
 *   - RFC1918 ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x
 *   - CGNAT range: 100.64.0.0/10
 */
function isBlockedHost(hostname: string): boolean {
  // Strip IPv6 brackets if present, then lowercase
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const raw = stripped.toLowerCase();

  // Exact match or subdomain match against blocked hosts list
  for (const blocked of BLOCKED_CURL_HOSTS) {
    if (raw === blocked || raw.endsWith(`.${blocked}`)) return true;
  }

  // IPv6: loopback, unspecified, link-local (fe80::/10), unique-local (fc00::/7)
  if (raw.includes(':')) {
    if (
      raw === '::1' ||
      raw === '::' ||
      raw === '0:0:0:0:0:0:0:1' ||
      raw.startsWith('fe80:') ||
      raw.startsWith('fc') ||
      raw.startsWith('fd')
    ) {
      return true;
    }

    // IPv4-mapped IPv6: ::ffff:<ipv4-dotted> or ::ffff:<hex>:<hex>
    if (raw.startsWith('::ffff:')) {
      const v4part = raw.slice(7); // strip "::ffff:"
      // Determine if it's dotted-decimal or hex-pair form
      const dotted = v4part.includes('.')
        ? v4part
        : hexPairsToDotted(v4part);
      if (dotted !== null && isBlockedHost(dotted)) return true;
    }

    return false;
  }

  // RFC1918 / link-local / CGNAT numeric ranges (IPv4 dotted-decimal)
  const octets = raw.split('.').map(Number);
  if (octets.length === 4) {
    const [a, b] = octets as [number, number, number, number];
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16-31.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
  }

  return false;
}

/**
 * Strict curl safety check — rejects all non-read, non-public invocations.
 *
 * Returns true ONLY if the curl command:
 *  - Has -s / -sS / --silent (silent mode required)
 *  - Does NOT have -o / -O / --output / --remote-name (no file write)
 *  - Does NOT match any BLOCKED_CURL_PATTERNS
 *  - Does NOT reference any blocked host in extracted URLs
 *
 * @param command - Full raw command string (already metachar-checked).
 */
function isCurlExfilSafe(command: string): boolean {
  const lower = command.toLowerCase();

  // Must have silent flag somewhere in the command
  const hasSilent =
    /\B-[a-zA-Z]*s/.test(command) ||   // -s or combined like -sS, -Ss
    lower.includes('--silent');
  if (!hasSilent) return false;

  // Must NOT have output-to-file flags
  if (
    /\B-[a-zA-Z]*[oO]/.test(command) ||
    lower.includes('--output') ||
    lower.includes('--remote-name')
  ) {
    return false;
  }

  // Check against blocked patterns
  for (const pattern of BLOCKED_CURL_PATTERNS) {
    if (typeof pattern === 'string') {
      if (lower.includes(pattern.toLowerCase())) return false;
    } else {
      if (pattern.test(command)) return false;
    }
  }

  // Extract URLs (tokens starting with http:// or https://) and check hosts
  const tokens = command.trim().split(/\s+/);
  for (const token of tokens) {
    if (/^https?:\/\//i.test(token)) {
      try {
        const url = new URL(token);
        if (isBlockedHost(url.hostname)) return false;
      } catch {
        // Malformed URL — reject to be safe
        return false;
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determines whether a command string is on the static allowlist and can
 * be executed without human approval.
 *
 * @param command - Raw command string as the agent would pass to the shell.
 * @returns `true` if the command is explicitly allowed; `false` otherwise.
 */
export function isAllowlisted(command: string): boolean {
  if (typeof command !== 'string' || command.trim() === '') return false;

  // Step 1: Reject immediately if shell metacharacters are present.
  // This must be the very first check to prevent bypass via chaining.
  if (hasShellMetachars(command)) return false;

  // Tokenize by whitespace (safe because metachar check already passed)
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const firstToken = tokens[0]!;

  // Step 2: Reject absolute or relative path prefixes.
  // Prevents symlink attacks: /tmp/cat → might be a malicious binary.
  // Users must specify bare command names only.
  if (firstToken.includes('/')) return false;

  const baseName = path.basename(firstToken).toLowerCase();

  // Step 3: Single-token check
  if (SAFE_SINGLE_COMMANDS.has(baseName)) return true;

  // Step 3b: text tools that are read-only UNLESS an in-place write flag is
  // present. Auto-approve only the read form; a write flag defers to approval.
  if (TEXT_TOOLS_WITH_WRITE.has(baseName)) {
    return !INPLACE_WRITE_RE.test(command);
  }

  // Step 4: curl special handling (strict SSRF + exfil guard)
  if (baseName === 'curl') return isCurlExfilSafe(command);

  // Step 5: Two-token pair check
  if (tokens.length >= 2) {
    const firstArg = tokens[1]!.toLowerCase();
    const pairKey = `${baseName} ${firstArg}`;
    if (SAFE_TWO_TOKEN_PAIRS.has(pairKey)) return true;
  }

  return false;
}
