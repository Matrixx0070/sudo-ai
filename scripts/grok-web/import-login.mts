/**
 * One-time cookie-import login for the free grok.com web lane.
 *
 * Log into grok.com in YOUR browser once, then export cookies and pipe them in:
 *
 *   # raw Cookie header (DevTools → Network → any grok.com req → Copy → cookie),
 *   # or a Cookie-Editor JSON export, or a cookies.txt — all accepted:
 *   GROK_UA="<paste your browser User-Agent>" \
 *     npx tsx scripts/grok-web/import-login.mts < cookies.txt
 *
 * cf_clearance is User-Agent-bound — GROK_UA MUST be the SAME UA your browser
 * sent, or Cloudflare rejects the session. Prints a JSON result; verifies live
 * against the seat before persisting. No browser is launched here.
 */

import { readFileSync } from 'node:fs';
import { importGrokWebSession } from '../../src/llm/grok-web-login.js';

const cookie = readFileSync(0, 'utf8'); // stdin
const userAgent = process.env['GROK_UA'];

const result = await importGrokWebSession(
  { cookie, ...(userAgent ? { userAgent } : {}) },
  { verify: process.env['GROK_IMPORT_NO_VERIFY'] !== '1' },
);

// Never print the cookie — only the coarse result.
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
