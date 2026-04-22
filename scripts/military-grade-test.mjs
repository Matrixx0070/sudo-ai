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
await input.fill('What do you need to build yourself advanced generation tools at military level? I mean enterprise-grade, military-grade capabilities — the kind of tools that governments and defense organizations would pay millions for. Think: advanced OSINT, cyber intelligence, threat detection, signal analysis, encrypted communications, geospatial intelligence, advanced penetration testing frameworks, zero-day research tools. What would make SUDO-AI the most powerful intelligence platform ever built? List everything you would need.');
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
  console.log(`Poll ${i+1}/50 — response ready: ${hasResponse}`);
  if (hasResponse && i > 10) break;
}

await page.evaluate(() => {
  const el = document.querySelector('[class*="messages"], main');
  if (el) el.scrollTop = el.scrollHeight;
});
await page.waitForTimeout(3000);

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/military-grade.png', fullPage: false });

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
