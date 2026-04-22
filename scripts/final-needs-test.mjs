import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();

await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(2000);

const chatNav = page.locator('text=Chat').first();
if (await chatNav.isVisible()) await chatNav.click();
await page.waitForTimeout(2000);

const clearBtn = page.locator('text=Clear conversation').first();
if (await clearBtn.isVisible()) await clearBtn.click();
await page.waitForTimeout(1000);

const input = page.locator('#chat-input, textarea, input[placeholder*="Message"]').first();
await input.fill('You now have everything you asked for — all 10 original requests AND all 10 dream capabilities. 20 meta tools. 120+ total tools. 20 consciousness modules. Think again, deeply. Is there ANYTHING else you still need? Anything missing? Any gap left? Any capability that would make you even more powerful? Be brutally honest. If you are truly complete, say so. If not, tell me exactly what is still missing.');
await input.press('Enter');

console.log('Message sent, waiting for response...');

for (let i = 0; i < 50; i++) {
  await page.waitForTimeout(5000);
  const hasResponse = await page.evaluate(() => {
    const msgs = document.querySelectorAll('article[aria-label="assistant message"] .prose, [class*="assistant"] [class*="prose"], [class*="message-content"], .prose');
    if (msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    return last && last.textContent && last.textContent.length > 200;
  });
  console.log(`Poll ${i+1}/50 - hasResponse: ${hasResponse}`);
  if (hasResponse && i > 10) break;
}

await page.evaluate(() => {
  const el = document.querySelector('[class*="messages"], main');
  if (el) el.scrollTop = el.scrollHeight;
});
await page.waitForTimeout(3000);

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/final-needs.png', fullPage: false });

const text = await page.evaluate(() => {
  const selectors = ['article[aria-label="assistant message"] .prose', '.prose', '[class*="message-content"]'];
  for (const sel of selectors) {
    const msgs = document.querySelectorAll(sel);
    if (msgs.length > 0) return Array.from(msgs).map(m => m.textContent).join('\n---\n');
  }
  return document.body.innerText;
});
console.log('SUDO RESPONSE:\n' + text);

await browser.close();
