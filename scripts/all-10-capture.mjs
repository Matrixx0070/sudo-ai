import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const ctx = contexts[0] || await browser.newContext();
const page = ctx.pages()[0] || await ctx.newPage();

// Navigate to the chat page (message should already be sent)
await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(2000);

// Click Chat nav if visible
const chatNav = page.locator('text=Chat').first();
if (await chatNav.isVisible()) await chatNav.click();
await page.waitForTimeout(2000);

// Wait for SUDO to finish responding - poll until no more streaming indicator
console.log('Waiting for SUDO-AI to finish responding...');
let attempts = 0;
const maxAttempts = 60; // up to 2 minutes of polling
while (attempts < maxAttempts) {
  // Check if there's a streaming/loading indicator
  const isStreaming = await page.evaluate(() => {
    // Look for cursor/typing indicators
    const cursor = document.querySelector('.cursor, .typing-indicator, [class*="streaming"], [class*="loading"]');
    // Also check if the last message content is still growing
    return !!cursor;
  });

  if (!isStreaming && attempts > 5) {
    console.log(`Response appears complete after ${attempts * 2}s`);
    break;
  }
  await page.waitForTimeout(2000);
  attempts++;
}

// Extra wait to be safe
await page.waitForTimeout(5000);

// Scroll to bottom
await page.evaluate(() => {
  const containers = document.querySelectorAll('div, main, section');
  containers.forEach(el => {
    if (el.scrollHeight > el.clientHeight) {
      el.scrollTop = el.scrollHeight;
    }
  });
});
await page.waitForTimeout(1000);

// Take screenshot
await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/all-10-confirmed.png', fullPage: false });

// Try multiple selector strategies to get the response text
const text = await page.evaluate(() => {
  // Strategy 1: Get all message bubbles/containers
  const allText = [];

  // Look for any element that contains the SUDO response
  const allElements = document.querySelectorAll('div, p, span, pre');
  const seen = new Set();

  for (const el of allElements) {
    const t = el.textContent?.trim();
    if (t && t.length > 100 && !seen.has(t)) {
      // Filter for likely message content
      if (t.includes('Unified Memory') || t.includes('Self-Healing') || t.includes('complete') || t.includes('confirm') || t.includes('SUDO')) {
        seen.add(t);
        allText.push(t);
      }
    }
  }

  if (allText.length > 0) return allText.join('\n---SEPARATOR---\n');

  // Strategy 2: Just get everything in the main content area
  const main = document.querySelector('main') || document.querySelector('[class*="chat"]') || document.querySelector('[class*="message"]');
  return main ? main.textContent : document.body.textContent;
});

console.log('=== SUDO-AI RESPONSE ===');
console.log(text);
console.log('=== END RESPONSE ===');

// Also dump the page HTML structure for debugging
const structure = await page.evaluate(() => {
  const msgs = document.querySelectorAll('[class*="message"], [class*="msg"], [class*="chat"]');
  return Array.from(msgs).map(m => `${m.tagName}.${m.className}: ${m.textContent?.substring(0, 200)}`).join('\n');
});
console.log('\n=== DOM STRUCTURE ===');
console.log(structure);

await browser.close();
