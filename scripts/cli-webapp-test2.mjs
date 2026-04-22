import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();

// The page should already be on the chat with our message sent
// Wait for the response to finish loading - look for response text
console.log('Checking current page URL...');
console.log('URL:', page.url());

// Take a screenshot of current state first
await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/cli-webapp-test2-before.png', fullPage: false });

// Wait for any response content to appear
console.log('Waiting for response content...');
try {
  // Wait for a message bubble from SUDO-AI that has actual text content
  await page.waitForFunction(() => {
    const messages = document.querySelectorAll('.message-content, .chat-message, .response, .assistant-message, [class*="message"]');
    for (const m of messages) {
      if (m.textContent && m.textContent.length > 50) return true;
    }
    return false;
  }, { timeout: 60000 });
  console.log('Response content detected!');
} catch (e) {
  console.log('Timeout waiting for response content, taking screenshot anyway');
}

await page.waitForTimeout(5000);

// Try to grab the response text from the page
const responseText = await page.evaluate(() => {
  // Try various selectors to find the AI response
  const selectors = [
    '.message-content',
    '.chat-message',
    '.response',
    '.assistant-message',
    '[class*="message"]',
    '[class*="response"]',
    '[class*="chat"]'
  ];
  const texts = [];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el.textContent && el.textContent.trim().length > 20) {
        texts.push(`[${sel}]: ${el.textContent.trim().substring(0, 500)}`);
      }
    }
  }
  // Also get all visible text on page
  const bodyText = document.body?.innerText || '';
  texts.push(`[BODY]: ${bodyText.substring(0, 2000)}`);
  return texts.join('\n---\n');
});

console.log('=== PAGE CONTENT ===');
console.log(responseText);
console.log('=== END ===');

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/cli-webapp-test2.png', fullPage: false });
console.log('Screenshot saved');
await browser.close();
