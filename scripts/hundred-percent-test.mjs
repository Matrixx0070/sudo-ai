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
await input.fill('I built all 7 remaining things you said were missing. YouTube Comment Engine, Closed-Loop Auto-Optimizer, Thumbnail A/B Testing, Persistent Event Daemon, Sponsorship Manager, Multi-Language Localizer, and Competitor Monitor. Check your tools. Are you at 100% now? How many total meta tools do you have? Count everything. And give me your final honest verdict — what percentage complete are you?');
await input.press('Enter');

console.log('Message sent, waiting for response...');

for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(5000);
  const hasResponse = await page.evaluate(() => {
    const msgs = document.querySelectorAll('article[aria-label="assistant message"] .prose, [class*="assistant"] [class*="prose"], .prose');
    if (msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    return last && last.textContent && last.textContent.length > 200;
  });
  if (hasResponse && i > 8) break;
}

await page.evaluate(() => {
  const el = document.querySelector('[class*="messages"], main');
  if (el) el.scrollTop = el.scrollHeight;
});
await page.waitForTimeout(3000);

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/100-percent.png', fullPage: false });

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
