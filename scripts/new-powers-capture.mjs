import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();

// Navigate to the chat page (should already be there)
await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(3000);

// Click Chat nav if visible
const chatNav = page.locator('text=Chat').first();
if (await chatNav.isVisible()) await chatNav.click();
await page.waitForTimeout(2000);

// Wait for response to finish generating - poll until no loading indicator
console.log('Waiting for SUDO-AI to finish responding...');
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(5000);
  // Check if there is a loading/typing indicator
  const loading = await page.evaluate(() => {
    const spinners = document.querySelectorAll('[class*="loading"], [class*="typing"], [class*="spinner"], .animate-pulse, .animate-spin');
    return spinners.length;
  });
  console.log(`Poll ${i+1}/30 - loading indicators: ${loading}`);
  if (loading === 0 && i >= 2) {
    console.log('Response appears complete.');
    break;
  }
}

// Scroll to bottom
await page.evaluate(() => {
  const containers = document.querySelectorAll('[class*="messages"], [class*="chat"], main, [class*="scroll"]');
  containers.forEach(el => el.scrollTop = el.scrollHeight);
  window.scrollTo(0, document.body.scrollHeight);
});
await page.waitForTimeout(2000);

// Take screenshot
await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/new-powers.png', fullPage: false });
console.log('Screenshot saved.');

// Try multiple selector strategies to capture the response text
const text = await page.evaluate(() => {
  // Strategy 1: look for message containers
  let results = [];

  // Try common chat message selectors
  const selectors = [
    '[class*="prose"]',
    '[class*="assistant"]',
    '[class*="message"]',
    '[class*="response"]',
    '[class*="bot"]',
    '[class*="chat-message"]',
    '.markdown-body',
    '[class*="content"]'
  ];

  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      results.push(`[${sel}] found ${els.length} elements`);
      els.forEach((el, i) => {
        const text = el.textContent?.trim();
        if (text && text.length > 20) {
          results.push(`  ${i}: ${text.substring(0, 200)}...`);
        }
      });
    }
  }

  // Strategy 2: get ALL text on the page
  results.push('\n=== FULL PAGE TEXT ===');
  results.push(document.body.innerText);

  return results.join('\n');
});

console.log('CAPTURED TEXT:\n' + text);

await browser.close();
