/**
 * @file notebooklm/zone-screen.ts
 * @description The hard zone screen (Prime invariant 1). Nothing zone-0 or
 * zone-1 may enter an exported NotebookLM Doc. Two independent checks:
 *   (a) zone classification — classifyZone(text) must be 2;
 *   (b) an INDEPENDENT secrets regex — belt-and-braces, so a classifier gap
 *       can't leak a credential (the two named exceptions, F64 pack-internal
 *       and F43 declassified transcript, do NOT use this module).
 * Refuse-and-throw on any hit; the export engine drops the offending record and
 * the sweep test asserts a seeded zone-1 record never reaches output.
 */

import { classifyZone } from '../gdrive/zones.js';

export class ZoneScreenError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`zone-screen: ${reason}`);
    this.name = 'ZoneScreenError';
    this.reason = reason;
  }
}

/**
 * Independent secrets patterns. Deliberately overlaps ZONE1_PATTERNS in
 * zones.ts (that's the point — a second, separately-maintained net). Leans
 * broad: a false positive costs one dropped record, a false negative leaks.
 */
const SECRETS_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'private_key_block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'gcp_oauth_secret', re: /\bGOCSPX-[\w-]{10,}\b/ },
  { name: 'bearer_token', re: /\b(?:bearer|authorization)\s*[:=]\s*['"]?[A-Za-z0-9._-]{20,}/i },
  { name: 'api_key_kv', re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9._\/+-]{12,}/i },
  { name: 'password_kv', re: /\b(?:password|passphrase|passwd)\b\s*[:=]\s*\S{6,}/i },
  { name: 'hex_secret_64', re: /\b[0-9a-f]{64}\b/i },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'credit_card', re: /\b(?:\d[ -]?){13,16}\b/ },
];

export interface ZoneScreenResult {
  ok: boolean;
  reason?: string;
}

/** Non-throwing screen: ok iff zone-2 AND no secrets hit. */
export function screenZone2(text: string): ZoneScreenResult {
  const zone = classifyZone(text);
  if (zone !== 2) return { ok: false, reason: `content classified zone-${zone} (only zone-2 may export)` };
  for (const p of SECRETS_PATTERNS) {
    if (p.re.test(text)) return { ok: false, reason: `secrets-regex hit: ${p.name}` };
  }
  return { ok: true };
}

/** Throwing variant for the final-Doc gate. */
export function assertZone2(text: string, context = 'export'): void {
  const r = screenZone2(text);
  if (!r.ok) throw new ZoneScreenError(`${context}: ${r.reason}`);
}

/** Filter a batch of records to zone-2-safe ones; returns kept + dropped counts. */
export function screenRecords<T>(
  records: T[],
  textOf: (r: T) => string,
): { kept: T[]; dropped: Array<{ record: T; reason: string }> } {
  const kept: T[] = [];
  const dropped: Array<{ record: T; reason: string }> = [];
  for (const r of records) {
    const res = screenZone2(textOf(r));
    if (res.ok) kept.push(r);
    else dropped.push({ record: r, reason: res.reason ?? 'unknown' });
  }
  return { kept, dropped };
}
