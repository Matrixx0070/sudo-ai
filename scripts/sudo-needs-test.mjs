import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();

await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(2000);

// Find chat nav and click
const chatNav = page.locator('text=Chat').first();
if (await chatNav.isVisible()) await chatNav.click();
await page.waitForTimeout(2000);

// Clear conversation
const clearBtn = page.locator('text=Clear conversation').first();
if (await clearBtn.isVisible()) await clearBtn.click();
await page.waitForTimeout(1000);

// Find chat input and type
const input = page.locator('#chat-input, textarea, input[placeholder*="Message"]').first();
await input.fill('Be honest with me. What do YOU actually need for yourself? What tools, skills, or capabilities are you missing that would make YOU better at your job? Not what Frank needs — what do YOU as SUDO-AI think you need to build for your own usage to become more powerful and autonomous? List everything you wish you had.');
await input.press('Enter');

console.log('Message sent, waiting 40s for response...');
await page.waitForTimeout(40000);

// Scroll to see full response
await page.evaluate(() => {
  const chatArea = document.querySelector('[class*="messages"], [class*="chat-body"], main, [class*="scroll"]');
  if (chatArea) chatArea.scrollTop = chatArea.scrollHeight;
});
await page.waitForTimeout(2000);

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/sudo-needs.png', fullPage: false });
console.log('Screenshot saved');

// Also extract text
const responseText = await page.evaluate(() => {
  const msgs = document.querySelectorAll('[class*="message"], [class*="prose"], [class*="assistant"]');
  return Array.from(msgs).map(m => m.textContent).join('\n---\n');
});
console.log('SUDO RESPONSE:\n' + responseText);

await browser.close();
