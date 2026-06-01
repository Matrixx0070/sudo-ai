/**
 * @file core/federation/federation-error-sanitizer.ts
 * @description Sanitizes incoming error report payloads from untrusted peer bots.
 *
 * Protects against:
 *   - XSS via errorSignature and stackTrace fields
 *   - Path disclosure (strips full paths, keeps filename only)
 *   - Secret leakage (API keys, tokens, connection strings, AWS keys)
 *   - Oversized payloads (64KB body limit, 8KB stack trace cap)
 *   - Dangerous meta keys (code/script/eval/exec/command injection)
 *
 * Wave 2 — Federation Error Protocol.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum body size for route-level check (64KB). */
export const MAX_BODY_BYTES = 65536;

/** Maximum errorSignature length (500 chars). */
const MAX_SIGNATURE_BYTES = 500;

/** Maximum stackTrace length (8KB). */
const MAX_STACK_BYTES = 8192;

/** Maximum meta JSON size (1KB). */
const MAX_META_BYTES = 1024;

/** Valid severity levels. */
const VALID_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const);

/** Semver regex for botVersion validation. */
const SEMVER_RE = /^\d+\.\d+\.\d+/;

/** PeerId validation regex (alphanumeric, underscore, hyphen, 1-64 chars). */
const PEER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Dangerous meta keys to reject (injection vectors). */
const DANGEROUS_META_KEYS_RE = /^(code|script|eval|exec|command)$/i;

/** IPv4 address pattern for redaction. */
const IPV4_RE = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g;

/**
 * Check if an IPv6 address is private (link-local, ULA, or localhost).
 * Used to avoid false positives on public IPv6 addresses.
 */
function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();

  // Localhost: ::1 (exact match, check before port stripping to avoid false match on :1)
  if (lower === '::1' || lower.startsWith('::1:')) {
    return true;
  }

  // Remove trailing port for validation (e.g., fe80::1:8080 -> fe80::1)
  // Only strip if there's a proper port (not just :1 which could be part of ::1)
  let withoutPort = lower;
  if (lower.match(/:\d{2,5}$/)) {
    withoutPort = lower.replace(/:\d{2,5}$/, '');
  } else if (lower.match(/:[0-9a-f]{1,4}:\d{2,5}$/)) {
    // Handle case like fe80::1:8080 where :1 is part of address
    withoutPort = lower.replace(/:\d{2,5}$/, '');
  }

  // Link-local: fe80::/10 (fe80, fe90, fea0, feb0)
  if (/^fe[89ab][0-9a-f]{0,4}(:|$)/i.test(withoutPort)) {
    return true;
  }
  // ULA: fc00::/7 (fc and fd prefixes)
  if (/^f[cd][0-9a-f]{0,4}(:|$)/i.test(withoutPort)) {
    return true;
  }
  return false;
}

/** IPv6 candidate pattern: matches full IPv6 addresses (compressed or not), optionally followed by a port. */
const IPV6_CANDIDATE_RE = /(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|fe[89ab][0-9a-fA-F]{0,4}::[0-9a-fA-F:]{1,}|f[cd][0-9a-fA-F]{0,4}::[0-9a-fA-F:]{1,}|::1(?:\b|:\d{1,5})/g;

/** Null byte pattern for stripping. */
const NULL_BYTE_RE = /\0/g;

/** Backtick pattern for XSS prevention in markdown contexts. */
const BACKTICK_RE = /`/g;

// Redaction patterns (applied in order)
const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // IPv4 addresses
  { pattern: IPV4_RE, replacement: '[IP]' },
  // API keys (various prefixes)
  { pattern: /(sk-|sk_live_|sk_test_|key_|token_|api_key|apikey)[a-zA-Z0-9_-]{8,}/gi, replacement: '[REDACTED]' },
  // Bearer tokens
  { pattern: /Bearer\s+[a-zA-Z0-9._-]+/gi, replacement: '[REDACTED]' },
  // Connection strings (database URLs)
  { pattern: /(mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi, replacement: '[REDACTED]' },
  // Passwords in URLs (before @ symbol)
  { pattern: /:([^@]{2,})@/g, replacement: ':[REDACTED]@' },
  // AWS access key IDs
  { pattern: /(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g, replacement: '[REDACTED]' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity level for error reports. */
export type SeverityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Sanitized error report shape — all strings cleaned, sizes capped. */
export interface SanitizedErrorReport {
  errorSignature: string;    // max 500 chars, paths stripped
  stackTrace?: string;       // max 8KB, redacted
  botVersion: string;        // semver validated
  peerId: string;            // validated
  timestamp: number;
  severity: SeverityLevel;
  toolName?: string;
  sessionId?: string;
  phase?: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize an incoming error report payload.
 * Strips paths, redacts secrets, caps sizes, validates required fields.
 *
 * @param report - Raw error report from peer (untrusted input)
 * @returns SanitizedErrorReport - Clean, validated error report
 * @throws Error if report is not an object, or required fields are invalid
 */
export function sanitizeErrorReport(report: unknown): SanitizedErrorReport {
  // Input type validation
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    throw new Error('sanitizeErrorReport: report must be a non-null object');
  }

  const obj = report as Record<string, unknown>;

  // Validate required fields
  if (typeof obj.errorSignature !== 'string') {
    throw new Error('sanitizeErrorReport: errorSignature is required and must be a string');
  }
  if (typeof obj.botVersion !== 'string') {
    throw new Error('sanitizeErrorReport: botVersion is required and must be a string');
  }
  if (typeof obj.peerId !== 'string') {
    throw new Error('sanitizeErrorReport: peerId is required and must be a string');
  }
  if (typeof obj.timestamp !== 'number' || Number.isNaN(obj.timestamp)) {
    throw new Error('sanitizeErrorReport: timestamp is required and must be a number');
  }

  // Validate peerId format
  if (!PEER_ID_RE.test(obj.peerId)) {
    throw new Error('sanitizeErrorReport: peerId must match /^[a-zA-Z0-9_-]{1,64}$/');
  }

  // Process severity (default to MEDIUM if invalid)
  const rawSeverity = obj.severity as string;
  const severity = (typeof rawSeverity === 'string' && VALID_SEVERITIES.has(rawSeverity as SeverityLevel))
    ? rawSeverity as SeverityLevel
    : 'MEDIUM';

  // Process botVersion (default to '0.0.0' if not semver, extract matched portion)
  const semverMatch = SEMVER_RE.exec(obj.botVersion);
  const botVersion = semverMatch ? semverMatch[0] : '0.0.0';

  // Process errorSignature: strip null bytes, trim, strip paths, strip IPs, cap size
  let errorSignature = obj.errorSignature
    .replace(NULL_BYTE_RE, '')
    .trim();

  // Strip file paths (keep filename only)
  errorSignature = errorSignature.replace(/(\/[^\s/:]+\.)+\w+/g, (match) => {
    const lastSlash = match.lastIndexOf('/');
    return lastSlash >= 0 ? match.slice(lastSlash + 1) : match;
  });

  // Strip IP addresses
  errorSignature = errorSignature.replace(IPV4_RE, '[IP]');

  // Cap to max size
  if (errorSignature.length > MAX_SIGNATURE_BYTES) {
    errorSignature = errorSignature.slice(0, MAX_SIGNATURE_BYTES);
  }

  // Process optional stackTrace
  let stackTrace: string | undefined;
  if (typeof obj.stackTrace === 'string') {
    stackTrace = capStackTrace(obj.stackTrace, MAX_STACK_BYTES);
  }

  // Process optional string fields
  const toolName = sanitizeOptionalString(obj.toolName);
  const sessionId = sanitizeOptionalString(obj.sessionId);
  const phase = sanitizeOptionalString(obj.phase);

  // Process meta field
  let meta: Record<string, unknown> | undefined;
  if (obj.meta !== undefined && obj.meta !== null) {
    meta = sanitizeMeta(obj.meta as Record<string, unknown>);
  }

  return {
    errorSignature,
    stackTrace,
    botVersion,
    peerId: obj.peerId.trim(),
    timestamp: obj.timestamp,
    severity,
    toolName,
    sessionId,
    phase,
    meta,
  };
}

/**
 * Cap a stack trace to maxBytes, truncating at last newline before limit.
 * Applies path stripping, IPv6 redaction, secret redaction, and backtick replacement.
 *
 * @param trace - Raw stack trace string
 * @param maxBytes - Maximum byte size (default 8192)
 * @returns Capped and sanitized stack trace
 */
export function capStackTrace(trace: string, maxBytes: number = MAX_STACK_BYTES): string {
  if (!trace || trace.length === 0) {
    return '';
  }

  // Strip null bytes first
  let cleaned = trace.replace(NULL_BYTE_RE, '');

  // Strip file paths (keep filename only) - BEFORE redactSecrets
  cleaned = cleaned.replace(/(?:\/[^\s/:]+)+\.\w+/g, (match) => {
    const lastSlash = match.lastIndexOf('/');
    return lastSlash >= 0 ? match.slice(lastSlash + 1) : match;
  });

  // Replace backticks with apostrophes to prevent markdown code block injection
  cleaned = cleaned.replace(BACKTICK_RE, "'");

  // Apply secret redaction (includes IPv4 and IPv6 private addresses)
  cleaned = redactSecrets(cleaned);

  // Cap to maxBytes
  if (cleaned.length <= maxBytes) {
    return cleaned;
  }

  // Truncate at last newline before maxBytes
  const slice = cleaned.slice(0, maxBytes);
  const lastNewline = slice.lastIndexOf('\n');

  if (lastNewline > 0) {
    return slice.slice(0, lastNewline);
  }

  // No newline found, hard truncate
  return slice;
}

/**
 * Redact secrets from content: tokens, API keys, passwords, connection strings.
 *
 * @param content - Raw string content that may contain secrets
 * @returns Sanitized string with secrets replaced with [REDACTED]
 */
export function redactSecrets(content: string): string {
  if (!content || content.length === 0) {
    return '';
  }

  let result = content;

  // First, redact IPv6 private addresses (requires validation)
  result = result.replace(IPV6_CANDIDATE_RE, (match) => {
    if (isPrivateIPv6(match)) {
      return '[IPV6]';
    }
    return match; // Keep public IPv6 unchanged
  });

  // Then apply other redaction patterns
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize an optional string field.
 * Returns undefined if not a string, otherwise strips null bytes and trims.
 */
function sanitizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.replace(NULL_BYTE_RE, '').trim();
}

/**
 * Sanitize meta field: validate size, strip dangerous keys, clean string values.
 *
 * @param meta - Raw meta object
 * @returns Sanitized meta object
 * @throws Error if meta JSON exceeds MAX_META_BYTES
 */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(meta)) {
    // Reject dangerous keys
    if (DANGEROUS_META_KEYS_RE.test(key)) {
      continue;
    }

    // Clean string values (strip null bytes)
    const cleanedValue = typeof value === 'string'
      ? value.replace(NULL_BYTE_RE, '').trim()
      : value;

    result[key] = cleanedValue;
  }

  // Validate size
  const jsonSize = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (jsonSize > MAX_META_BYTES) {
    throw new Error(`sanitizeErrorReport: meta exceeds ${MAX_META_BYTES} bytes (${jsonSize} bytes)`);
  }

  return result;
}
