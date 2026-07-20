#!/usr/bin/env node
/**
 * GW2 manual smoke — GATED, real-net, NOT run in CI.
 *
 * Exercises the replay bridge against a REAL captured grok.com session. Requires
 * an opt-in env flag and a captured cookie so it never runs by accident (and
 * never in CI, where there is no session and no network).
 *
 * Usage:
 *   SUDO_GROK_WEB_SMOKE=1 \
 *   GROK_WEB_COOKIE_FILE=/tmp/grok-cookie-header.txt \
 *   [GROK_WEB_STATSIG=<x-statsig-id>] \
 *   node scripts/grok-web/smoke.mjs [probe|image|video]
 *
 * Secrets are read from files/env and never printed.
 */
import { readFileSync } from 'node:fs';
import { callGrokWebBridge } from '../../src/llm/grok-web-bridge.js';

if (process.env.SUDO_GROK_WEB_SMOKE !== '1') {
  console.error('Refusing to run: set SUDO_GROK_WEB_SMOKE=1 to opt in (real-net, real quota).');
  process.exit(2);
}
const cookieFile = process.env.GROK_WEB_COOKIE_FILE;
if (!cookieFile) {
  console.error('Set GROK_WEB_COOKIE_FILE to a file containing the captured grok.com Cookie header.');
  process.exit(2);
}
const cookie = readFileSync(cookieFile, 'utf8').trim();
const userAgent =
  process.env.GROK_WEB_UA ??
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const statsigId = process.env.GROK_WEB_STATSIG;
const creds = { cookie, userAgent, statsigId };
const which = process.argv[2] ?? 'probe';

const redact = (r) => {
  const c = { ...r };
  if (Array.isArray(c.images)) c.images = c.images.map((i) => ({ jobId: i.jobId, bytes: i.b64 ? Buffer.from(i.b64, 'base64').length : 0, publicUrl: i.publicUrl }));
  return c;
};

if (which === 'probe') {
  console.log('probe:', JSON.stringify(redact(await callGrokWebBridge({ op: 'probe' }, creds))));
} else if (which === 'image') {
  console.log('image:', JSON.stringify(redact(await callGrokWebBridge({ op: 'image', prompt: 'a single green leaf on white', aspectRatio: '1:1', numGenerations: 1, timeoutSec: 90 }, creds))));
} else if (which === 'video') {
  const img = await callGrokWebBridge({ op: 'image', prompt: 'a red apple on white', aspectRatio: '1:1', numGenerations: 1, timeoutSec: 90 }, creds);
  const url = img.images?.[0]?.publicUrl;
  if (!url) { console.error('image step failed:', JSON.stringify(redact(img))); process.exit(1); }
  if (!statsigId) { console.error('video needs GROK_WEB_STATSIG'); process.exit(2); }
  console.log('video:', JSON.stringify(redact(await callGrokWebBridge({ op: 'video', imageUrl: url, aspectRatio: '1:1', videoLength: 6, resolutionName: '720p', timeoutSec: 150 }, creds))));
} else {
  console.error('unknown smoke:', which);
  process.exit(2);
}
