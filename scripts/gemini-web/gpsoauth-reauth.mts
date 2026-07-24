// Browserless re-auth CLI: re-mint the Gemini session from the durable gpsoauth master
// token (or a one-time oauth_token seed) and validate with a live "pong". This is the same
// re-mint the session manager runs automatically when __Secure-1PSID dies.
//
// Prereq (one-time, human): data/gemini-gpsoauth-seed.json (0600) — see
// src/llm/gemini-gpsoauth-reauth.ts (mintGeminiCookiesViaGpsoauth). After that this is
// browserless and re-runnable on demand.
//
// Run:  node --import tsx scripts/gemini-web/gpsoauth-reauth.mts [seedFile]
// SECURITY: tokens/cookies are never printed; the seed + session files are 0600.
import { GeminiWebSessionManager, generateGeminiWebText } from '../../src/llm/gemini-web-session-manager.js';
import { mintGeminiCookiesViaGpsoauth } from '../../src/llm/gemini-gpsoauth-reauth.js';

const cookies = await mintGeminiCookiesViaGpsoauth(process.argv[2]);
if (!cookies) {
  console.error('gpsoauth mint failed / no seed — see logs above. Re-seed if the master token is stale/revoked.');
  process.exit(1);
}
new GeminiWebSessionManager().saveFromCookies(cookies);
console.log(`minted ${Object.keys(cookies).length} google cookies; __Secure-1PSID present.`);

// The mint already produced __Secure-1PSID, so this live check is a bonus. Google can return
// oversized response headers right after a mint — if undici trips UND_ERR_HEADERS_OVERFLOW,
// re-run with NODE_OPTIONS=--max-http-header-size=131072; the session is still minted.
try {
  const reply = await generateGeminiWebText('Reply with exactly one word: pong');
  console.log(`session refreshed browserlessly. live check reply: ${JSON.stringify(reply.slice(0, 40))}`);
} catch (e) {
  console.log(
    `session minted (__Secure-1PSID written); live check skipped: ${(e as Error).message.slice(0, 80)}. ` +
      'Re-run with NODE_OPTIONS=--max-http-header-size=131072 to probe.',
  );
}
