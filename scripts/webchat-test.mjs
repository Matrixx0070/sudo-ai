import { chromium } from 'playwright-core';

const CDP_URL = 'http://localhost:9222';
const APP_URL = 'http://localhost:3001';
const SCREENSHOT_PATH = '/root/sudo-ai-v3/screenshots/webchat-test.png';

async function run() {
  console.log('[1] Connecting to Chrome via CDP...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  console.log(`    Connected. Contexts: ${browser.contexts().length}`);

  // Create a fresh context and page so we don't interfere with existing tabs
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  try {
    // Step 1: Navigate to the web UI
    console.log('[2] Navigating to', APP_URL);
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('    Page loaded. Title:', await page.title());

    // Step 2: Click the "Chat" nav button in the AdminSidebar
    console.log('[3] Looking for Chat nav button...');
    const chatBtn = page.locator('button[aria-label="Chat"]');
    await chatBtn.waitFor({ state: 'visible', timeout: 10000 });
    console.log('    Found Chat button, clicking...');
    await chatBtn.click();

    // Step 3: Wait for chat view to load (the immersive chat view with the input)
    console.log('[4] Waiting for chat input to appear...');
    const chatInput = page.locator('#chat-input');
    await chatInput.waitFor({ state: 'visible', timeout: 10000 });
    console.log('    Chat input visible.');

    // Step 4: Type the message
    console.log('[5] Typing "Who are you?"...');
    await chatInput.fill('Who are you?');
    // Small pause to let React state update
    await page.waitForTimeout(500);

    // Step 5: Click send
    console.log('[6] Clicking Send button...');
    const sendBtn = page.locator('button[aria-label="Send message"]');
    await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
    await sendBtn.click();
    console.log('    Message sent.');

    // Step 6: Wait for the AI response
    console.log('[7] Waiting up to 20 seconds for AI response...');
    // The assistant message starts empty and gets content appended.
    // We wait for any element with role="assistant" or a message bubble with content.
    // Based on InputBar.tsx, the message goes through IPC and comes back.
    // Let's wait for either the streaming text or a non-empty assistant message.

    // First wait a moment for the message to appear in DOM
    await page.waitForTimeout(2000);

    // Wait for either an assistant response or error text to appear
    // The response should appear as text content in the chat area
    try {
      // Wait for the streaming/response to complete - look for the input to become enabled again
      // (it's disabled during streaming)
      await page.waitForFunction(
        () => {
          const input = document.querySelector('#chat-input');
          return input && !(input).disabled;
        },
        { timeout: 20000 }
      );
      console.log('    Response complete (input re-enabled).');
    } catch {
      console.log('    Timeout waiting for response completion, taking screenshot anyway.');
    }

    // Extra pause to let any final rendering complete
    await page.waitForTimeout(1000);

    // Step 7: Take screenshot
    console.log('[8] Taking screenshot...');
    await page.screenshot({
      path: SCREENSHOT_PATH,
      fullPage: false,
    });
    console.log('    Screenshot saved to', SCREENSHOT_PATH);

    // Log what we can see on the page
    const pageContent = await page.textContent('body');
    const truncated = pageContent?.substring(0, 500) || '(empty)';
    console.log('[9] Visible page text (first 500 chars):', truncated);

  } catch (err) {
    console.error('ERROR:', err.message);
    // Take a screenshot even on error so we can see what happened
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
    // Don't close the browser - it's shared via CDP
  }
}

run().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
