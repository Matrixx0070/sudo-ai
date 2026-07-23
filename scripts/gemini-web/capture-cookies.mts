// One-time capture: read Google cookies from a logged-in gemini.google.com browser
// (CDP endpoint, default display-10 on 9222) and persist them to the 0600 session file
// via GeminiWebSessionManager. After running this, the Gemini web lane runs headless.
//
// Run:  node --import tsx scripts/gemini-web/capture-cookies.mts [cdpPort]
// SECURITY: cookies are written only to the 0600 session file; never printed.
import { chromium } from 'playwright';
import { GeminiWebSessionManager } from '../../src/llm/gemini-web-session-manager.js';

const port = Number(process.argv[2] || process.env.GROK_CDP_PORT || 9222);

const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const ctx = b.contexts()[0];
  if (!ctx) {
    console.error(`no browser context on CDP ${port}`);
    process.exit(2);
  }
  const cookies = await ctx.cookies('https://gemini.google.com');
  const map: Record<string, string> = {};
  for (const c of cookies) {
    if ((c.domain || '').includes('google.com')) map[c.name] = c.value;
  }
  if (!map['__Secure-1PSID']) {
    console.error('no __Secure-1PSID — not logged into gemini.google.com in this profile. Aborting.');
    process.exit(2);
  }

  // Best-effort real User-Agent from an open Gemini tab (falls back to the manager default).
  let ua: string | undefined;
  const page = ctx.pages().find((p) => /gemini\.google\.com/.test(p.url()));
  if (page) ua = await page.evaluate(() => navigator.userAgent).catch(() => undefined);

  new GeminiWebSessionManager().saveFromCookies(map, ua);
  console.log(
    `captured ${Object.keys(map).length} google.com cookies -> session file (0600). ` +
      `1PSID present, 1PSIDTS ${map['__Secure-1PSIDTS'] ? 'present' : 'MISSING'}, UA ${ua ? 'captured' : 'default'}.`,
  );
} finally {
  await b.close();
}
