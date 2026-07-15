/**
 * @file secrets/secret-ref.ts
 * @description Indirect secret resolution ("SecretRef"), modelled on the OpenClaw
 * gateway secrets contract (docs.openclaw.ai/gateway/secrets). A secret can be
 * declared as `{ source: "env"|"file"|"exec", provider, id }` and resolved to
 * material at load time — instead of pasting the raw value into config/env.
 *
 * Two guarantees:
 *  1. BACK-COMPAT: `resolveSecretValue()` accepts EITHER a raw string (returned
 *     verbatim — identity) OR a SecretRef. Every existing plaintext secret keeps
 *     working unchanged, so wiring a call site through this seam is a no-op until
 *     someone actually declares a SecretRef.
 *  2. NEVER LOG RAW: resolved material is a plain string the caller must not log;
 *     a SecretRef itself is posture-only (`{source, provider}`) — see
 *     `secretPosture()` and the SecretRef branch in shared/redact.ts.
 *
 * Kill-switch: SUDO_SECRETS_REF=0 disables SecretRef resolution entirely (plain
 * strings still pass through, so legacy behaviour is byte-for-byte preserved).
 * `exec` source is additionally gated behind SUDO_SECRETS_ALLOW_EXEC=1 because it
 * is side-effecting (spec: audit skips exec plans unless --allow-exec).
 */

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { createLogger } from '../shared/logger.js';

const log = createLogger('secrets:secret-ref');

export type SecretSource = 'env' | 'file' | 'exec';

export interface SecretRef {
  source: SecretSource;
  provider: string;
  id: string;
}

// Spec regexes (Part 4 §Canonical Frame Schemas): provider is a short slug; id is
// a bounded token that also carries the optional `path#selector` for file/env JSON.
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,63}$/;
// Spec id regex, relaxed to allow a leading '/' so absolute file paths
// (/run/secrets/...) validate. Path-traversal (./..) is caught separately in
// parseSecretRef for the file source; env/exec ids never start with '/'.
const ID_RE = /^[A-Za-z0-9/][A-Za-z0-9._:/#-]{0,255}$/;

export const SecretRefSchema = z
  .object({
    source: z.enum(['env', 'file', 'exec']),
    provider: z.string().regex(PROVIDER_RE),
    id: z.string().regex(ID_RE),
  })
  .strict();

/** SUDO_SECRETS_REF=0 turns SecretRef resolution off (plain strings still pass). */
export function secretsRefEnabled(): boolean {
  return process.env['SUDO_SECRETS_REF'] !== '0';
}

/** exec source is opt-in only — it runs a command. */
export function secretsAllowExec(): boolean {
  return process.env['SUDO_SECRETS_ALLOW_EXEC'] === '1';
}

/** Structural guard: is this value shaped like a SecretRef (not a plain string)? */
export function isSecretRef(v: unknown): v is SecretRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>)['source'] === 'string' &&
    (['env', 'file', 'exec'] as string[]).includes((v as Record<string, unknown>)['source'] as string)
  );
}

/** Validate an arbitrary value into a SecretRef, or null (with a reason logged). */
export function parseSecretRef(v: unknown): SecretRef | null {
  const parsed = SecretRefSchema.safeParse(v);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues.map((i) => i.path.join('.') + ':' + i.code) }, 'invalid SecretRef');
    return null;
  }
  const ref = parsed.data;
  // Path-traversal guard for file source: reject any `.`/`..` segment. The `#`
  // selector is split off first so a legit `dir/f.json#a.b` is not misread.
  if (ref.source === 'file') {
    const path = ref.id.split('#', 1)[0] ?? '';
    if (path.split('/').some((seg) => seg === '.' || seg === '..')) {
      log.warn({ provider: ref.provider }, 'file SecretRef rejected: "." / ".." path segment');
      return null;
    }
  }
  return ref;
}

/** Extract a value from parsed JSON by a `#selector`: a JSON Pointer (/a/b, with
 * ~1→/ and ~0→~ per RFC 6901) or a bare top-level key. */
function selectFromJson(raw: string, selector: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const tokens = selector.startsWith('/')
    ? selector
        .slice(1)
        .split('/')
        .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
    : [selector];
  let cur: unknown = doc;
  for (const tok of tokens) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[tok];
  }
  if (cur === undefined || cur === null) return null;
  return typeof cur === 'string' ? cur : String(cur);
}

/**
 * Resolve a SecretRef to its material, or null on any failure (fail-closed — the
 * caller treats null as "no secret configured"). Never logs the resolved value.
 */
export function resolveSecretRef(ref: SecretRef): string | null {
  if (!secretsRefEnabled()) {
    log.warn({ source: ref.source, provider: ref.provider }, 'SecretRef resolution disabled (SUDO_SECRETS_REF=0)');
    return null;
  }
  try {
    switch (ref.source) {
      case 'env': {
        // id = ENV_NAME or ENV_NAME#json_selector (env holds a JSON blob).
        const [name, selector] = splitSelector(ref.id);
        const raw = process.env[name];
        if (!raw) return null;
        const out = selector ? selectFromJson(raw, selector) : raw;
        return out && out.length > 0 ? out : null;
      }
      case 'file': {
        const [path, selector] = splitSelector(ref.id);
        if (!isAbsolute(path)) {
          log.warn({ provider: ref.provider }, 'file SecretRef must be an absolute path');
          return null;
        }
        const raw = readFileSync(path, 'utf8');
        const out = selector ? selectFromJson(raw, selector) : raw.replace(/\r?\n$/, '');
        return out && out.length > 0 ? out : null;
      }
      case 'exec': {
        if (!secretsAllowExec()) {
          log.warn({ provider: ref.provider }, 'exec SecretRef blocked (set SUDO_SECRETS_ALLOW_EXEC=1 to allow)');
          return null;
        }
        // id is a command line; run it without a shell (argv split on whitespace).
        const argv = ref.id.split(/\s+/).filter(Boolean);
        const cmd = argv[0];
        if (!cmd) return null;
        const out = execFileSync(cmd, argv.slice(1), { encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20 });
        const trimmed = out.replace(/\r?\n$/, '');
        return trimmed.length > 0 ? trimmed : null;
      }
      default:
        return null;
    }
  } catch (err) {
    // Deliberately does NOT include the value or the full path/command in the log.
    log.error({ source: ref.source, provider: ref.provider, err: err instanceof Error ? err.name : 'error' }, 'SecretRef resolution failed');
    return null;
  }
}

/** Split `base#selector` into [base, selector|undefined] (first `#` only). */
function splitSelector(id: string): [string, string | undefined] {
  const hash = id.indexOf('#');
  if (hash < 0) return [id, undefined];
  return [id.slice(0, hash), id.slice(hash + 1) || undefined];
}

/**
 * The back-compat seam. A plain string is returned verbatim (identity); a
 * SecretRef (or SecretRef-shaped object) is resolved. null/undefined → null.
 */
export function resolveSecretValue(input: string | SecretRef | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return input.length > 0 ? input : null;
  if (isSecretRef(input)) {
    const ref = parseSecretRef(input);
    return ref ? resolveSecretRef(ref) : null;
  }
  return null;
}

/**
 * Gateway env seam: read secret `NAME`, but if `NAME_REF` is set (a JSON
 * SecretRef) and SecretRef is enabled, resolve THAT instead. With no `_REF`
 * variable present this is exactly `process.env[NAME]` — a no-op for every
 * existing deployment.
 */
export function resolveEnvSecret(name: string): string | null {
  if (secretsRefEnabled()) {
    const refJson = process.env[`${name}_REF`];
    if (refJson && refJson.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(refJson);
      } catch {
        log.error({ name: `${name}_REF` }, 'SecretRef env var is not valid JSON — credential unavailable (fail-closed)');
        return null; // configured-but-broken → fail closed, do NOT fall back to open
      }
      const ref = parseSecretRef(parsed);
      return ref ? resolveSecretRef(ref) : null;
    }
  }
  // No _REF: pure identity to process.env[name] — an empty string is preserved
  // (some callers treat a configured-but-empty secret as a distinct error), and
  // only an unset var becomes null. Keeps every migrated call site byte-for-byte.
  const raw = process.env[name];
  return raw ?? null;
}

/** Buffer form for timing-safe comparisons (returns null when unset/unresolved). */
export function resolveEnvSecretBuffer(name: string): Buffer | null {
  const v = resolveEnvSecret(name);
  return v && v.length > 0 ? Buffer.from(v, 'utf8') : null;
}

/**
 * Resolve a map whose values are each a plain string OR a SecretRef (e.g. an MCP
 * server's `env` block). Unresolvable entries are dropped. Plain-string values
 * pass through unchanged, so an all-string map is returned as-is.
 */
export function resolveSecretMap(map: Record<string, string | SecretRef> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!map) return out;
  for (const [k, v] of Object.entries(map)) {
    const r = resolveSecretValue(v);
    if (r !== null) out[k] = r;
  }
  return out;
}

/** Logging-safe posture: source/provider only, never the material or id. */
export function secretPosture(input: string | SecretRef | null | undefined): { source: 'inline' | SecretSource; provider?: string } {
  if (isSecretRef(input)) return { source: input.source, provider: input.provider };
  return { source: 'inline' };
}
