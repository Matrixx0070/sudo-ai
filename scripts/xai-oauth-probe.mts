/**
 * xai-oauth Phase 0 tier-validation probe (per plan: run BEFORE any integration).
 *
 * Flow: OIDC discovery → device-code login (prints verification URL + code) →
 * poll token endpoint (honors interval + slow_down) → persist tokens 0600 →
 * ONE minimal /v1/responses call with grok-4.3.
 *
 * Verdicts: 200 → tier allowlisted, integration can proceed.
 *           403 → "tier not allowlisted — use XAI_API_KEY path", exit 1, STOP.
 *
 * OAuth constants extracted from the reference implementation
 * (NousResearch/hermes-agent hermes_cli/auth.py) — never invented:
 *   issuer https://auth.x.ai, client_id b1a00492-073a-47ea-816f-4c329264a828,
 *   scope "openid profile email offline_access grok-cli:access api:access".
 * Tokens are NEVER printed.
 */
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ISSUER = 'https://auth.x.ai';
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const API_BASE = process.env['XAI_BASE_URL']?.trim() || 'https://api.x.ai/v1';
const MODEL = process.env['XAI_PROBE_MODEL']?.trim() || 'grok-4.3';
const TOKEN_FILE = join(process.env['DATA_DIR'] ?? './data', 'xai-oauth.json');
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function log(msg: string): void {
  console.log(`[xai-probe] ${msg}`);
}

async function main(): Promise<void> {
  // 1. OIDC discovery — endpoints resolved at runtime, like the reference.
  const disc = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as {
    device_authorization_endpoint: string;
    token_endpoint: string;
  };
  log(`discovery ok: device=${disc.device_authorization_endpoint} token=${disc.token_endpoint}`);

  // 2. Device authorization.
  const devRes = await fetch(disc.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  if (!devRes.ok) {
    log(`FATAL: device authorization failed: ${devRes.status} ${(await devRes.text()).slice(0, 300)}`);
    process.exit(2);
  }
  const dev = (await devRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };
  log('=== ACTION REQUIRED ===');
  log(`OPEN:  ${dev.verification_uri_complete ?? dev.verification_uri}`);
  log(`CODE:  ${dev.user_code}`);
  log('=== waiting for approval (up to 10 min) ===');

  // 3. Poll token endpoint honoring interval + slow_down.
  let intervalS = Math.max(dev.interval ?? 5, 1);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let tokens: { access_token: string; refresh_token?: string; expires_in?: number } | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalS * 1000));
    const res = await fetch(disc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: dev.device_code,
        client_id: CLIENT_ID,
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok && typeof json['access_token'] === 'string') {
      tokens = json as typeof tokens & Record<string, unknown>;
      break;
    }
    const err = String(json['error'] ?? '');
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      intervalS += 5;
      continue;
    }
    log(`FATAL: token polling failed: ${res.status} error=${err}`);
    process.exit(2);
  }
  if (!tokens) {
    log('FATAL: approval timed out after 10 minutes.');
    process.exit(2);
  }

  // 4. Persist BEFORE first use (0600, atomic tmp+rename).
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  const tmp = `${TOKEN_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...tokens, obtained_at: new Date().toISOString() }), { mode: 0o600 });
  renameSync(tmp, TOKEN_FILE);
  log(`tokens persisted to ${TOKEN_FILE} (0600). Login SUCCESS.`);

  // 5. ONE minimal Responses call.
  const inf = await fetch(`${API_BASE}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ model: MODEL, input: 'Reply with the single word: ready', max_output_tokens: 16 }),
  });
  const bodyText = (await inf.text()).slice(0, 400);
  if (inf.status === 403) {
    log(`inference: HTTP 403 — tier not allowlisted — use XAI_API_KEY path`);
    log(`body: ${bodyText}`);
    process.exit(1);
  }
  if (!inf.ok) {
    log(`inference: HTTP ${inf.status} (not the 403 tier gate — see body)`);
    log(`body: ${bodyText}`);
    process.exit(2);
  }
  log(`inference: HTTP 200 — TIER ALLOWLISTED ✓ model=${MODEL}`);
  log(`body snippet: ${bodyText.slice(0, 200)}`);
  process.exit(0);
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
