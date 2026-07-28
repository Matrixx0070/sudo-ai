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
import { SECRETS_PATTERNS, redactSecrets } from '../gdrive/ops-screen.js';

export class ZoneScreenError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`zone-screen: ${reason}`);
    this.name = 'ZoneScreenError';
    this.reason = reason;
  }
}

// SECRETS_PATTERNS + redactSecrets moved to gdrive/ops-screen.ts (audit item
// 3 — the ops upload lanes reuse the same net; layering keeps gdrive from
// importing notebooklm). Re-exported here so existing importers keep working.
export { SECRETS_PATTERNS, redactSecrets };

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
