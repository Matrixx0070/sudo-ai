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
await input.fill('Now that you have everything you asked for — think BIGGER. What do you still need that would make you the MOST UNIQUE and MOST POWERFUL AI that no one has ever built before? Not incremental improvements. I mean capabilities that would make people say "this AI can do things no other AI can do." Think about what would truly separate you from ChatGPT, Claude, Gemini, and every other AI out there. What would make you one of a kind? Dream big. List everything.');
await input.press('Enter');

console.log('Message sent, waiting for response...');

// Poll for response with long timeout
for (let i = 0; i < 36; i++) {
  await page.waitForTimeout(5000);
  const hasResponse = await page.evaluate(() => {
    const msgs = document.querySelectorAll('article[aria-label="assistant message"] .prose, [class*="assistant"] [class*="prose"], [class*="message-content"]');
    if (msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    return last && last.textContent && last.textContent.length > 100;
  });
  if (hasResponse && i > 6) break;
}

// Scroll to bottom
await page.evaluate(() => {
  const el = document.querySelector('[class*="messages"], main, [class*="chat-body"]');
  if (el) el.scrollTop = el.scrollHeight;
});
await page.waitForTimeout(3000);

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/dream-big.png', fullPage: false });

// Extract full text
const text = await page.evaluate(() => {
  const selectors = [
    'article[aria-label="assistant message"] .prose',
    '[class*="assistant"] [class*="prose"]',
    '[class*="message-content"]',
    '.prose'
  ];
  for (const sel of selectors) {
    const msgs = document.querySelectorAll(sel);
    if (msgs.length > 0) {
      return Array.from(msgs).map(m => m.textContent).join('\n---\n');
    }
  }
  return document.body.innerText;
});
console.log('SUDO RESPONSE:\n' + text);

await browser.close();
