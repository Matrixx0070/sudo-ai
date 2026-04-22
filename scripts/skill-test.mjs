import { chromium } from 'playwright-core';

const CDP_URL = 'http://localhost:9222';
const APP_URL = 'http://localhost:3001';
const SCREENSHOT_PATH = '/root/sudo-ai-v3/screenshots/skills-test.png';

async function run() {
  console.log('[1] Connecting to Chrome via CDP...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  console.log(`    Connected. Contexts: ${browser.contexts().length}`);

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  try {
    // Step 1: Navigate to the web UI
    console.log('[2] Navigating to', APP_URL);
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('    Page loaded. Title:', await page.title());

    // Step 2: Click the "Chat" nav button
    console.log('[3] Looking for Chat nav button...');
    const chatBtn = page.locator('button[aria-label="Chat"]');
    await chatBtn.waitFor({ state: 'visible', timeout: 10000 });
    console.log('    Found Chat button, clicking...');
    await chatBtn.click();

    // Step 3: Wait for chat input
    console.log('[4] Waiting for chat input to appear...');
    const chatInput = page.locator('#chat-input');
    await chatInput.waitFor({ state: 'visible', timeout: 10000 });
    console.log('    Chat input visible.');

    // Step 4: Type the message
    const message = 'Did you make your own skills? List the skills you created yourself.';
    console.log(`[5] Typing: "${message}"...`);
    await chatInput.fill(message);
    await page.waitForTimeout(500);

    // Step 5: Click send
    console.log('[6] Clicking Send button...');
    const sendBtn = page.locator('button[aria-label="Send message"]');
    await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
    await sendBtn.click();
    console.log('    Message sent.');

    // Step 6: Wait for AI response (25+ seconds)
    console.log('[7] Waiting up to 30 seconds for AI response...');
    await page.waitForTimeout(2000);

    try {
      await page.waitForFunction(
        () => {
          const input = document.querySelector('#chat-input');
          return input && !input.disabled;
        },
        { timeout: 30000 }
      );
      console.log('    Response complete (input re-enabled).');
    } catch {
      console.log('    Timeout waiting for response completion, taking screenshot anyway.');
    }

    // Extra pause to let rendering finish
    await page.waitForTimeout(2000);

    // Step 7: Scroll down to see the full response
    console.log('[8] Scrolling to bottom of chat...');
    await page.evaluate(() => {
      const chatArea = document.querySelector('[class*="chat"]') || document.querySelector('[class*="message"]') || document.querySelector('main');
      if (chatArea) chatArea.scrollTop = chatArea.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1000);

    // Step 8: Take screenshot
    console.log('[9] Taking screenshot...');
    await page.screenshot({
      path: SCREENSHOT_PATH,
      fullPage: false,
    });
    console.log('    Screenshot saved to', SCREENSHOT_PATH);

    // Log visible page text
    const pageContent = await page.textContent('body');
    const truncated = pageContent?.substring(0, 2000) || '(empty)';
    console.log('[10] Visible page text (first 2000 chars):', truncated);

  } catch (err) {
    console.error('ERROR:', err.message);
    try {
      await page.screenshot({
        path: SCREENSHOT_PATH.replace('.png', '-error.png'),
        fullPage: false,
      });
      console.log('    Error screenshot saved.');
    } catch (ssErr) {
      console.error('    Could not take error screenshot:', ssErr.message);
    }
    throw err;
  } finally {
    await context.close();
  }
}

run().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
