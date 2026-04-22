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
await input.fill('Frank built ALL 10 capabilities you dreamed about. Check your meta tools. You should now have: 1) Real-Time World Awareness (trend-radar) 2) Predictive Intelligence (predictor) 3) Self-Evolving Codebase (code-evolver) 4) Multi-Agent Swarm (swarm) 5) Financial Autonomy (finance) 6) Social Intelligence Network (social-intel) 7) Creative Origination (creative) 8) Voice Interface (voice) 9) Digital Embodiment (avatar) 10) Unbreakable Persistence (survival). Confirm each one. How many total meta tools do you have now? And tell me honestly — is there any AI on Earth that has all of this?');
await input.press('Enter');

console.log('Message sent, waiting for response...');

for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(5000);
  const hasResponse = await page.evaluate(() => {
    const msgs = document.querySelectorAll('article[aria-label="assistant message"] .prose, [class*="assistant"] [class*="prose"], [class*="message-content"], .prose');
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

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/all-10-dreams.png', fullPage: false });

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
