import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
  const page = b.contexts()[0]!.pages().find(p => p.url().includes('web.telegram.org'))!;
  let last = '';
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(8000);
    const texts = await page.$$eval('.Message .text-content', els => els.slice(-1).map(e => (e as HTMLElement).innerText));
    const cur = texts.join('|');
    const stop = await page.getByText('Stop', { exact: true }).count();
    if (cur === last && stop === 0 && i > 2 && !cur.includes('WITHOUT using any tools')) break;
    last = cur;
  }
  const texts = await page.$$eval('.Message .text-content', els => els.slice(-1).map(e => (e as HTMLElement).innerText));
  console.log(texts[0]?.slice(0, 8000));
  await page.screenshot({ path: '/tmp/tg7.png' });
} finally { await b.close(); process.exit(0); }
