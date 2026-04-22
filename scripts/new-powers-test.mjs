import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();

await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(3000);

// Click Chat nav if visible
const chatNav = page.locator('text=Chat').first();
if (await chatNav.isVisible()) await chatNav.click();
await page.waitForTimeout(2000);

// Clear any old conversation
const clearBtn = page.locator('text=Clear conversation').first();
if (await clearBtn.isVisible()) await clearBtn.click();
await page.waitForTimeout(1000);

// Type and send the message
const input = page.locator('#chat-input, textarea, input[placeholder*="Message"]').first();
await input.fill('I just built you 4 new systems: 1) Unified Memory (query all your DBs at once), 2) Self-Healing Watchdog (auto-detect and fix problems), 3) Task Queue with orchestration (priority queue, dependencies, retries), 4) YouTube Feedback Loop (learn from video performance). Check your new meta tools and tell me what you now have. Are you more powerful now?');
await input.press('Enter');

console.log('Message sent. Waiting 90 seconds for SUDO-AI to respond...');
await page.waitForTimeout(90000);

// Scroll to bottom
await page.evaluate(() => {
  const containers = document.querySelectorAll('[class*="messages"], [class*="chat"], main, [class*="scroll"]');
  containers.forEach(el => { if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight; });
  window.scrollTo(0, document.body.scrollHeight);
});
await page.waitForTimeout(2000);

// Screenshot
await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/new-powers.png', fullPage: false });
console.log('Screenshot saved.');

// Extract ALL text from the page body
const fullText = await page.evaluate(() => document.body.innerText);
console.log('=== FULL PAGE TEXT ===');
console.log(fullText);

// Also try to get just the assistant message
const assistantText = await page.evaluate(() => {
  // Look for the second message bubble (assistant response)
  const allDivs = Array.from(document.querySelectorAll('div'));
  const messageDivs = allDivs.filter(d => {
    const text = d.textContent?.trim();
    return text && text.length > 100 && d.children.length < 20;
  });
  // Return the longest div text that is not the user message
  let longest = '';
  for (const d of messageDivs) {
    const t = d.textContent?.trim();
    if (t && t.length > longest.length && !t.includes('I just built you 4 new systems')) {
      longest = t;
    }
  }
  return longest;
});

if (assistantText && assistantText.length > 50) {
  console.log('\n=== SUDO-AI RESPONSE (extracted) ===');
  console.log(assistantText);
}

await browser.close();
