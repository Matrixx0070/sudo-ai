import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();

// Go to SUDO-AI
await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(2000);

// Find chat nav and click
const chatNav = page.locator('text=Chat').first();
if (await chatNav.isVisible()) await chatNav.click();
await page.waitForTimeout(2000);

// Clear conversation if button exists
const clearBtn = page.locator('text=Clear conversation').first();
if (await clearBtn.isVisible()) await clearBtn.click();
await page.waitForTimeout(1000);

// Find chat input and type
const input = page.locator('#chat-input, textarea, input[placeholder*="Message"]').first();
await input.fill('Did you use any web app by CLI? Like ChatGPT, Gemini, YouTube Studio, or any other web service through browser automation or CLI tools? Tell me everything you have accessed.');
await input.press('Enter');

console.log('Message sent, waiting 35s for response...');
await page.waitForTimeout(35000);

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/cli-webapp-test.png', fullPage: false });
console.log('Screenshot saved');
await browser.close();
