import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();

// Scroll to top of chat to capture the full response from beginning
await page.evaluate(() => {
  const chatContainer = document.querySelector('.chat-messages, .messages, [class*="chat"], [class*="messages"]');
  if (chatContainer) chatContainer.scrollTop = 0;
  else window.scrollTo(0, 0);
});
await page.waitForTimeout(1000);

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/cli-webapp-test3-top.png', fullPage: false });
console.log('Top screenshot saved');

// Now get full page screenshot
await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/cli-webapp-test3-full.png', fullPage: true });
console.log('Full page screenshot saved');

await browser.close();
