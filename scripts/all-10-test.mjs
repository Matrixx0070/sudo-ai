import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

// Create a fresh context so we get a clean WebSocket connection
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();

try {
  // Navigate to admin UI
  console.log('[1] Navigating to http://localhost:3001...');
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
  console.log('    Page loaded.');

  // Click Chat nav button
  console.log('[2] Clicking Chat button...');
  const chatBtn = page.locator('button[aria-label="Chat"]');
  await chatBtn.waitFor({ state: 'visible', timeout: 10000 });
  await chatBtn.click();
  await page.waitForTimeout(2000);

  // Wait for chat input
  console.log('[3] Waiting for chat input...');
  const chatInput = page.locator('#chat-input');
  await chatInput.waitFor({ state: 'visible', timeout: 10000 });
  console.log('    Chat input visible.');

  // Type the message
  const message = 'I built ALL 10 things you asked for. Check your meta tools and new modules. Here is what you should now have: 1) Unified Memory 2) Self-Healing Watchdog 3) Task Queue 4) API Cost Tracking 5) YouTube Feedback Loop 6) Better Error Context 7) Smart Scheduling 8) Skill Versioning + Rollback 9) Real Autonomy Infrastructure (event loop + plans) 10) Test Harness. Confirm each one exists. Are you now complete?';
  console.log('[4] Filling message...');
  await chatInput.fill(message);
  await page.waitForTimeout(500);

  // Click send
  console.log('[5] Clicking Send...');
  const sendBtn = page.locator('button[aria-label="Send message"]');
  await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
  await sendBtn.click();
  console.log('    Message sent at', new Date().toISOString());

  // The key issue: the ipc-client.ts WebSocket fallback creates a single-shot
  // WebSocket. The agent takes ~50-60 seconds. The WebSocket has a 120s timeout.
  // We must keep this page alive with no navigation for the full duration.
  //
  // The response flow:
  // 1. InputBar calls ipcInvoke('agent:send-message', {message})
  // 2. ipcInvoke (no window.sudo) falls back to WebSocket
  // 3. WebSocket connects to ws://localhost:3001/ws
  // 4. Sends the message
  // 5. WebAdapter._dispatch -> agentLoop.run() (takes ~50s)
  // 6. Response comes back via ws.onmessage
  // 7. ipcInvoke resolves with {success: true, response}
  // 8. InputBar calls store.appendToMessage()
  // 9. store.setStreaming(false)
  //
  // We need to wait for step 9 — input becomes not disabled.

  console.log('[6] Waiting up to 180s for response...');

  // Poll every 5 seconds, checking if the assistant message has content
  let found = false;
  let everDisabled = false; // only trust re-enable after we saw streaming disable the input
  for (let i = 0; i < 36; i++) { // 36 * 5s = 180s
    await page.waitForTimeout(5000);

    const elapsed = (i + 1) * 5;

    // Check if an assistant message article exists with content
    const hasResponse = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[aria-label="assistant message"]');
      for (const a of articles) {
        const prose = a.querySelector('.prose');
        if (prose && prose.textContent && prose.textContent.trim().length > 10) {
          return true;
        }
      }
      return false;
    });

    if (hasResponse) {
      console.log(`    Response detected after ${elapsed}s!`);
      found = true;
      break;
    }

    // Also check if input is re-enabled (streaming done)
    const inputEnabled = await page.evaluate(() => {
      const input = document.querySelector('#chat-input');
      return input && !input.disabled;
    });

    if (!inputEnabled) everDisabled = true;

    // Only trust the re-enable shortcut once we have actually seen the input
    // become disabled by streaming. Otherwise the brief window after send (or an
    // immediate error) where input was never disabled would falsely report success.
    if (everDisabled && inputEnabled && elapsed > 10) {
      // Input re-enabled could mean response arrived or error
      console.log(`    Input re-enabled after ${elapsed}s, checking for response...`);
      await page.waitForTimeout(2000);
      found = true;
      break;
    }

    console.log(`    Still waiting... ${elapsed}s elapsed`);
  }

  if (!found) {
    console.log('    WARNING: 180s timeout reached without detecting a response.');
  }

  // Extra wait for rendering
  await page.waitForTimeout(3000);

  // Scroll all scrollable containers to bottom
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach(el => {
      if (el.scrollHeight > el.clientHeight + 10) {
        el.scrollTop = el.scrollHeight;
      }
    });
  });
  await page.waitForTimeout(1000);

  // Take screenshot
  await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/all-10-confirmed.png', fullPage: false });
  console.log('[7] Screenshot saved.');

  // Extract assistant message text
  const responseText = await page.evaluate(() => {
    const results = [];
    // Check article[aria-label="assistant message"] elements
    const articles = document.querySelectorAll('article[aria-label="assistant message"]');
    for (const a of articles) {
      const prose = a.querySelector('.prose');
      if (prose) results.push(prose.textContent);
    }
    if (results.length > 0) return results.join('\n---\n');

    // Fallback: get all text from the message log area
    const log = document.querySelector('[role="log"]');
    if (log) return log.textContent;

    return '(no response found)';
  });

  console.log('\n=== SUDO-AI RESPONSE ===');
  console.log(responseText);
  console.log('=== END RESPONSE ===');

} catch (err) {
  console.error('ERROR:', err.message);
  try {
    await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/all-10-error.png', fullPage: false });
    console.log('Error screenshot saved.');
  } catch {}
} finally {
  await context.close();
  // Do NOT close browser — it is shared via CDP
}
