/**
 * @file secrets/snapshot.ts
 * @description Runtime secret-snapshot operations behind the `secrets.reload` /
 * `secrets.resolve` gateway RPC methods (OpenClaw spec: secrets.reload refreshes
 * the runtime snapshot without a restart, last-known-good on failure; secrets.resolve
 * probes a credential). Both are POSTURE-ONLY — no resolved secret material is ever
 * returned or logged.
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  parseSecretRef,
  resolveEnvSecret,
  resolveSecretRef,
  type SecretRef,
  type SecretSource,
} from './secret-ref.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('secrets:snapshot');

// Curated credential surface (mirrors the CLI audit list).
const GATEWAY_KEYS = ['GATEWAY_TOKEN', 'GATEWAY_SECRET', 'WEB_CHAT_TOKEN'];
const CHANNEL_KEYS = [
  'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN',
  'SLACK_TOKEN', 'MATRIX_ACCESS_TOKEN', 'IRC_PASSWORD', 'GITHUB_TOKEN', 'WS_STREAMING_TOKEN',
];

function envFilePath(projectRoot: string): string {
  return path.resolve(projectRoot, 'config', '.env');
}

/** Minimal KEY=VALUE parser (strips surrounding quotes, ignores # comments). */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
    if (!m) continue;
    let v = m[2] ?? '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1] as string] = v;
  }
  return out;
}

export interface ReloadResult {
  reloaded: number;         // count of secret keys re-applied to process.env
  changed: string[];        // credential names whose value/ref changed
  unresolved: string[];     // credentials whose NEW _REF failed → kept last-known-good
}

/**
 * Re-apply the secret-related keys of config/.env to process.env WITHOUT a
 * restart. Scope is limited to the known credential surface + any `<NAME>_REF`
 * key + hook secretEnv names — arbitrary env is never touched. A new `_REF` that
 * fails to parse/resolve is NOT applied (last-known-good, no partial activation),
 * and is reported in `unresolved`. Never returns or logs any value.
 */
export async function reloadSecretSnapshot(projectRoot: string): Promise<ReloadResult> {
  const p = envFilePath(projectRoot);
  if (!fs.existsSync(p)) return { reloaded: 0, changed: [], unresolved: [] };
  const fileEnv = parseDotenv(fs.readFileSync(p, 'utf8'));

  // Build the set of secret keys we are allowed to touch.
  const bases = new Set<string>([...GATEWAY_KEYS, ...CHANNEL_KEYS]);
  try {
    const { loadWebhooks } = await import('../gateway/webhook-config.js');
    for (const h of Object.values(loadWebhooks(undefined, false).hooks)) if (h.secretEnv) bases.add(h.secretEnv);
  } catch { /* webhooks unavailable — skip hook secrets */ }
  const secretKeys = new Set<string>();
  for (const b of bases) { secretKeys.add(b); secretKeys.add(`${b}_REF`); }
  for (const k of Object.keys(fileEnv)) if (k.endsWith('_REF')) secretKeys.add(k);

  const changed = new Set<string>();
  const unresolved: string[] = [];
  let reloaded = 0;

  for (const key of secretKeys) {
    if (!(key in fileEnv)) continue;
    const next = fileEnv[key] as string;
    if (process.env[key] === next) continue; // unchanged
    const base = key.endsWith('_REF') ? key.slice(0, -'_REF'.length) : key;

    if (key.endsWith('_REF')) {
      // Validate BEFORE applying — last-known-good on failure.
      let ref: SecretRef | null = null;
      try { ref = parseSecretRef(JSON.parse(next)); } catch { ref = null; }
      if (!ref || resolveSecretRef(ref) === null) { unresolved.push(base); continue; }
    }
    process.env[key] = next;
    reloaded++;
    changed.add(base);
  }

  log.info({ reloaded, changed: [...changed], unresolved }, 'secret snapshot reloaded (values not logged)');
  return { reloaded, changed: [...changed], unresolved };
}

export type ResolveProbe =
  | { ok: true; name?: string; posture: 'inline' | 'missing' | `secretref:${SecretSource}`; provider?: string; resolves: boolean }
  | { ok: false; error: string };

/**
 * Probe whether a credential resolves — POSTURE ONLY, never the value. Accepts
 * either `{ name }` (a known credential env var) or `{ ref }` (an inline SecretRef).
 */
export function secretResolveProbe(params: { name?: string; ref?: unknown }): ResolveProbe {
  if (params.ref !== undefined) {
    const ref = parseSecretRef(params.ref);
    if (!ref) return { ok: false, error: 'invalid SecretRef' };
    return { ok: true, posture: `secretref:${ref.source}`, provider: ref.provider, resolves: resolveSecretRef(ref) !== null };
  }
  if (typeof params.name === 'string' && params.name) {
    const refJson = process.env[`${params.name}_REF`];
    if (refJson && refJson.trim()) {
      const ref = parseSecretRef((() => { try { return JSON.parse(refJson); } catch { return null; } })());
      if (!ref) return { ok: true, name: params.name, posture: 'missing', resolves: false };
      return { ok: true, name: params.name, posture: `secretref:${ref.source}`, provider: ref.provider, resolves: resolveEnvSecret(params.name) !== null };
    }
    const raw = process.env[params.name];
    if (raw && raw.length > 0) return { ok: true, name: params.name, posture: 'inline', resolves: true };
    return { ok: true, name: params.name, posture: 'missing', resolves: false };
  }
  return { ok: false, error: 'provide { name } or { ref }' };
}
