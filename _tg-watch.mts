import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const page = b.contexts()[0]!.pages().find(p => p.url().includes('web.telegram.org'));
  if (!page) { console.log('NO_TAB'); process.exit(0); }
  const authed = await page.evaluate(() => !!localStorage.getItem('user_auth'));
  console.log(authed ? 'LOGGED_IN' : 'waiting');
} finally { await b.close(); process.exit(0); }
