/**
 * @file gdrive/canonical-json.ts
 * @description Canonical JSON serialization — the single source of truth for
 * every byte that gets HMAC'd (F17). Manifest signature stability depends on
 * this function alone: sorted keys, no whitespace, undefined-valued keys
 * dropped (matching JSON.stringify semantics), cycles rejected.
 *
 * Do NOT "improve" the output format — any byte change invalidates every
 * existing manifest signature. Schema evolution goes through schemaVersion +
 * migrations (F36), never through this serializer.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(`canonical-json: ${message}`);
    this.name = 'CanonicalJsonError';
  }
}

/** Deterministically serialize a JSON-compatible value. */
export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet());
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new CanonicalJsonError(`non-finite number ${String(value)} is not canonicalizable`);
    }
    return JSON.stringify(value);
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new CanonicalJsonError(`top-level ${t} is not canonicalizable`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError('circular reference');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      // Array holes / undefined entries serialize as null (JSON.stringify parity).
      const parts = obj.map((v) =>
        v === undefined || typeof v === 'function' || typeof v === 'symbol'
          ? 'null'
          : serialize(v, seen),
      );
      return `[${parts.join(',')}]`;
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter((k) => {
        const v = rec[k];
        return v !== undefined && typeof v !== 'function' && typeof v !== 'symbol';
      })
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(rec[k], seen)}`);
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}
