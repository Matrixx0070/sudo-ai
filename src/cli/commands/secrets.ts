/**
 * @file cli/commands/secrets.ts
 * @description `sudo-ai secrets` sub-commands — operator tooling over the
 * SecretRef resolver (src/core/secrets/secret-ref.ts). Models the OpenClaw
 * gateway secrets CLI (docs.openclaw.ai/gateway/secrets):
 *
 *   secrets audit               Posture report for the credential surface +
 *                               findings (I90 reuse=CRITICAL, short token, exec
 *                               refs unresolvable). READ-ONLY. Exit 2 on CRITICAL.
 *   secrets apply [--dry-run]   Resolve every declared `<NAME>_REF` in config/.env
 *                               and report OK/FAIL. Preview only (activation is a
 *                               restart). --allow-exec enables exec sources.
 *   secrets configure ...       Validate --name/--source/--provider/--id into a
 *                               SecretRef and print the `<NAME>_REF=` line to add.
 *                               --write appends it to config/.env (with a .bak
 *                               backup); refuses to clobber a differing value
 *                               without --force.
 *
 * INVARIANT: never prints raw secret material — only posture (source/provider),
 * env-var names, and boolean resolves?. The SecretRef `id` (a file path or exec
 * command the operator is configuring) is shown by `configure` since the operator
 * is typing it; resolved values are never emitted.
 */

import path from 'node:path';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import {
  parseSecretRef,
  resolveEnvSecret,
  resolveSecretRef,
  type SecretRef,
  type SecretSource,
} from '../../core/secrets/secret-ref.js';

// ---------------------------------------------------------------------------
// Credential surface
// ---------------------------------------------------------------------------

interface Cred { name: string; group: string }

const GATEWAY_CREDS: Cred[] = [
  { name: 'GATEWAY_TOKEN', group: 'gateway' },
  { name: 'GATEWAY_SECRET', group: 'gateway' },
  { name: 'WEB_CHAT_TOKEN', group: 'gateway' },
];

const CHANNEL_CREDS: Cred[] = [
  'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN',
  'SLACK_TOKEN', 'MATRIX_ACCESS_TOKEN', 'IRC_PASSWORD', 'GITHUB_TOKEN', 'WS_STREAMING_TOKEN',
].map((name) => ({ name, group: 'channel' }));

const MIN_TOKEN_LEN = 16;

// ---------------------------------------------------------------------------
// dotenv hydration (so the CLI sees what the daemon will load)
// ---------------------------------------------------------------------------

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

/** Load config/.env into process.env for any key not already set (process-local). */
function hydrateEnv(projectRoot: string): void {
  const p = envFilePath(projectRoot);
  if (!fs.existsSync(p)) return;
  const parsed = parseDotenv(fs.readFileSync(p, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// posture (never exposes the value)
// ---------------------------------------------------------------------------

type Posture = 'missing' | 'inline' | `secretref:${SecretSource}`;

function postureOf(name: string): { posture: Posture; provider?: string; resolves: boolean } {
  const refJson = process.env[`${name}_REF`];
  if (refJson && refJson.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(refJson); } catch { return { posture: 'missing', resolves: false }; }
    const ref = parseSecretRef(parsed);
    if (!ref) return { posture: 'missing', resolves: false };
    return { posture: `secretref:${ref.source}`, provider: ref.provider, resolves: resolveEnvSecret(name) !== null };
  }
  const raw = process.env[name];
  if (raw && raw.length > 0) return { posture: 'inline', resolves: true };
  return { posture: 'missing', resolves: false };
}

function sameSecret(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

interface Finding { level: 'CRITICAL' | 'WARN' | 'INFO'; code: string; detail: string }

export async function runSecretsAudit(projectRoot: string): Promise<number> {
  hydrateEnv(projectRoot);
  const creds = [...GATEWAY_CREDS, ...CHANNEL_CREDS];
  const findings: Finding[] = [];

  console.log('SecretRef audit — credential posture (values never shown)\n');
  console.log('  GROUP    CREDENTIAL             POSTURE                 RESOLVES');
  console.log('  ' + '-'.repeat(66));
  for (const c of creds) {
    const { posture, provider, resolves } = postureOf(c.name);
    if (posture === 'missing' && c.group === 'channel') continue; // don't list unconfigured optional channels
    const postureStr = provider ? `${posture} (${provider})` : posture;
    console.log(`  ${c.group.padEnd(8)} ${c.name.padEnd(21)} ${postureStr.padEnd(23)} ${resolves ? 'yes' : 'NO'}`);
    if (posture === 'inline' && c.group === 'gateway') {
      findings.push({ level: 'INFO', code: 'inline_plaintext', detail: `${c.name} is a plaintext env value — consider a ${c.name}_REF SecretRef` });
    }
    if (posture.startsWith('secretref:exec') && process.env['SUDO_SECRETS_ALLOW_EXEC'] !== '1') {
      findings.push({ level: 'WARN', code: 'exec_ref_disabled', detail: `${c.name} is an exec SecretRef but SUDO_SECRETS_ALLOW_EXEC≠1 — it will not resolve` });
    }
  }

  // token length
  const gwTok = resolveEnvSecret('GATEWAY_TOKEN');
  if (gwTok && gwTok.length < MIN_TOKEN_LEN) {
    findings.push({ level: 'WARN', code: 'token_too_short', detail: `GATEWAY_TOKEN is ${gwTok.length} chars (< ${MIN_TOKEN_LEN}) — use a longer random token` });
  }

  // I90 — hook secret reuses gateway token
  try {
    const { loadWebhooks, hookSecret } = await import('../../core/gateway/webhook-config.js');
    const gwSecret = resolveEnvSecret('GATEWAY_SECRET');
    const hooks = loadWebhooks(undefined, true).hooks;
    for (const [id, hook] of Object.entries(hooks)) {
      const s = hookSecret(hook);
      if (s && (sameSecret(s, gwTok) || sameSecret(s, gwSecret))) {
        findings.push({ level: 'CRITICAL', code: 'hooks.token_reuse_gateway_token', detail: `hook "${id}" secret (${hook.secretEnv}) reuses the gateway token — I90 violation (the daemon drops this hook)` });
      }
    }
  } catch { /* webhooks not loadable — skip */ }

  console.log('\nFindings:');
  if (findings.length === 0) {
    console.log('  none — all audited credentials are well-formed.');
  } else {
    for (const f of findings) console.log(`  [${f.level}] ${f.code}: ${f.detail}`);
  }
  const critical = findings.filter((f) => f.level === 'CRITICAL').length;
  console.log(`\n${critical} critical, ${findings.filter((f) => f.level === 'WARN').length} warning(s).`);
  return critical > 0 ? 2 : 0;
}

// ---------------------------------------------------------------------------
// apply (resolution preflight — always a preview; activation is a restart)
// ---------------------------------------------------------------------------

export async function runSecretsApply(projectRoot: string, opts: { allowExec?: boolean } = {}): Promise<number> {
  hydrateEnv(projectRoot);
  if (opts.allowExec) process.env['SUDO_SECRETS_ALLOW_EXEC'] = '1';

  const refKeys = Object.keys(process.env).filter((k) => k.endsWith('_REF') && (process.env[k] ?? '').trim().startsWith('{'));
  console.log(`SecretRef apply (dry-run) — resolving ${refKeys.length} declared SecretRef(s)\n`);
  if (refKeys.length === 0) {
    console.log('  no `<NAME>_REF` SecretRefs declared in config/.env — nothing to resolve.');
    return 0;
  }
  let failed = 0;
  for (const key of refKeys.sort()) {
    const name = key.slice(0, -'_REF'.length);
    let ref: SecretRef | null = null;
    try { ref = parseSecretRef(JSON.parse(process.env[key] as string)); } catch { ref = null; }
    if (!ref) { console.log(`  ${name.padEnd(24)} INVALID (not a valid SecretRef)`); failed++; continue; }
    const ok = resolveSecretRef(ref) !== null;
    console.log(`  ${name.padEnd(24)} ${ref.source}/${ref.provider}  →  ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) failed++;
  }
  console.log(`\n${refKeys.length - failed}/${refKeys.length} resolve. (Preview only — restart the daemon to activate.)`);
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// configure (advisory by default; --write appends to config/.env)
// ---------------------------------------------------------------------------

export interface ConfigureOpts {
  name?: string;
  source?: string;
  provider?: string;
  id?: string;
  write?: boolean;
  force?: boolean;
}

export function runSecretsConfigure(projectRoot: string, opts: ConfigureOpts): number {
  if (!opts.name || !opts.source || !opts.id) {
    console.error('[secrets] configure requires --name, --source (env|file|exec) and --id');
    return 1;
  }
  const provider = opts.provider ?? 'default';
  const ref = parseSecretRef({ source: opts.source, provider, id: opts.id });
  if (!ref) {
    console.error('[secrets] invalid SecretRef — check --source (env|file|exec), --provider (^[a-z][a-z0-9_-]*$) and --id');
    return 1;
  }
  const envKey = `${opts.name}_REF`;
  const line = `${envKey}=${JSON.stringify(ref)}`;

  if (!opts.write) {
    console.log('Add this line to config/.env (then restart the daemon):\n');
    console.log(`  ${line}\n`);
    console.log('(advisory only — re-run with --write to append it automatically)');
    return 0;
  }

  const p = envFilePath(projectRoot);
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const cur = parseDotenv(existing)[envKey];
  if (cur !== undefined && cur !== JSON.stringify(ref) && !opts.force) {
    console.error(`[secrets] ${envKey} already set to a different value in config/.env — re-run with --force to overwrite`);
    return 1;
  }

  // backup then write (0600). Overwrite an existing key in place, else append.
  if (existing) fs.writeFileSync(`${p}.bak`, existing, { mode: 0o600 });
  let next: string;
  if (cur !== undefined) {
    next = existing.replace(new RegExp(`^${envKey}=.*$`, 'm'), line);
  } else {
    next = existing.endsWith('\n') || existing === '' ? `${existing}${line}\n` : `${existing}\n${line}\n`;
  }
  fs.writeFileSync(p, next, { mode: 0o600 });
  console.log(`[secrets] wrote ${envKey} to config/.env (backup: config/.env.bak). Restart the daemon to activate.`);
  return 0;
}
