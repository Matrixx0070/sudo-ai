/**
 * One-shot verification script for the Claude OAuth PKCE params.
 *
 * Run modes:
 *   tsx scripts/test-claude-pkce.ts start          — print authorize URL,
 *                                                    persist verifier+state to /tmp.
 *   tsx scripts/test-claude-pkce.ts complete CODE  — exchange the pasted code,
 *                                                    print the token response.
 *
 * This script does NOT touch the production credentials store — it writes a
 * separate verification record only.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import {
  generatePkceVerifier,
} from '../src/core/brain/claude-oauth-manager.js';

const STATE_PATH = '/tmp/claude-pkce-test.json';
// Authoritative endpoints extracted from claude-code 2.1.177:
//   CLAUDE_AI_AUTHORIZE_URL, TOKEN_URL, MANUAL_REDIRECT_URL, CLIENT_ID.
// Ground truth captured from `claude setup-token` (claude-code 2.1.177).
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// setup-token uses loopback redirect with a random port. The browser shows
// the code in the URL bar even if it cannot reach the loopback.
const REDIRECT_URI = 'http://localhost:39969/callback';
// setup-token uses minimal scope. The 6-scope set is for a different flow
// (/login subscription web) and isn't accepted here.
const SCOPE = 'user:inference';

interface PendingState {
  verifier: string;
  state: string;
  authorizeUrl: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

async function start(): Promise<void> {
  const verifier = generatePkceVerifier();
  const state = base64url(randomBytes(32));
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challengeFor(verifier),
    code_challenge_method: 'S256',
    state,
  });
  const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;
  const pending: PendingState = { verifier, state, authorizeUrl };
  writeFileSync(STATE_PATH, JSON.stringify(pending, null, 2), { mode: 0o600 });
  console.log('');
  console.log('AUTHORIZE URL (open in browser, approve, copy the code shown on the callback page):');
  console.log('');
  console.log(authorizeUrl);
  console.log('');
  console.log(`State persisted: ${STATE_PATH}`);
  console.log(`Then run:  tsx scripts/test-claude-pkce.ts complete <PASTED_CODE>`);
}

async function complete(rawCode: string): Promise<void> {
  if (!existsSync(STATE_PATH)) {
    console.error(`Missing pending state at ${STATE_PATH} — run "start" first.`);
    process.exit(1);
  }
  const pending = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as PendingState;
  const trimmed = rawCode.trim();
  const codePart = trimmed.split(/[#&?]/)[0] ?? trimmed;
  // Exact body shape Claude Code's setup-token sends (function nj6 in the
  // binary): JSON, with state and client_id, code is the raw value.
  const body = {
    grant_type: 'authorization_code',
    code: codePart,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: pending.verifier,
    state: pending.state,
  };

  console.log('POST', TOKEN_URL);
  console.log('Body:', JSON.stringify({ ...body, code_verifier: '<redacted>' }, null, 2));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log('');
  console.log(`Status: ${res.status} ${res.statusText}`);
  console.log('Response body:');
  console.log(text.substring(0, 2000));
  console.log('');
  if (res.ok) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      console.log('SUCCESS — keys present:', Object.keys(data).join(', '));
      if (typeof data['access_token'] === 'string') {
        const tok = data['access_token'] as string;
        console.log(`access_token prefix: ${tok.substring(0, 12)}...  length=${tok.length}`);
      }
    } catch {
      console.log('Response was not JSON.');
    }
    // Best-effort cleanup so the temp file does not linger.
    try { unlinkSync(STATE_PATH); } catch { /* ignore */ }
  } else {
    console.log('FAILED — keep the temp file so you can retry with another code.');
    process.exit(2);
  }
}

const mode = process.argv[2];
if (mode === 'start') {
  start().catch((e: unknown) => { console.error(e); process.exit(1); });
} else if (mode === 'complete') {
  const code = process.argv[3] ?? '';
  if (!code) {
    console.error('Usage: tsx scripts/test-claude-pkce.ts complete <CODE>');
    process.exit(1);
  }
  complete(code).catch((e: unknown) => { console.error(e); process.exit(1); });
} else {
  console.error('Usage: tsx scripts/test-claude-pkce.ts {start | complete <CODE>}');
  process.exit(1);
}
