import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();

console.log('Navigating to http://localhost:3001...');
await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(2000);

// Find chat nav and click
const chatNav = page.locator('text=Chat').first();
if (await chatNav.isVisible()) {
  console.log('Found Chat nav link, clicking...');
  await chatNav.click();
} else {
  console.log('Chat nav not visible, may already be on chat page');
}
await page.waitForTimeout(2000);

// Clear conversation if button exists
const clearBtn = page.locator('text=Clear conversation').first();
if (await clearBtn.isVisible()) {
  console.log('Found Clear conversation button, clicking...');
  await clearBtn.click();
  await page.waitForTimeout(1500);
} else {
  console.log('Clear conversation button not visible');
}

// Find chat input (textarea with id="chat-input")
const input = page.locator('#chat-input');
await input.waitFor({ state: 'visible', timeout: 5000 });
console.log('Found chat input, typing message...');
await input.fill('Did you make your own skills? List all skills you created yourself with their names and what they do.');
await page.waitForTimeout(500);
await input.press('Enter');

console.log('Message sent. Waiting for assistant response (up to 90s)...');

// Wait for the assistant response to appear and finish
// The assistant bubble is: article[aria-label="assistant message"]
// When streaming is done, the content will be rendered as ReactMarkdown (not StreamingText)
// We look for a non-empty assistant message

let responseText = '';
const startTime = Date.now();
const maxWait = 90000; // 90 seconds

while (Date.now() - startTime < maxWait) {
  await page.waitForTimeout(3000);

  // Get all assistant message articles
  const assistantMessages = page.locator('article[aria-label="assistant message"]');
  const count = await assistantMessages.count();

  if (count > 0) {
    // Get the last assistant message
    const lastMsg = assistantMessages.last();
    const text = await lastMsg.textContent();

    if (text && text.trim().length > 10) {
      // Check if streaming is done by looking for the prose div (ReactMarkdown rendered)
      const proseDiv = lastMsg.locator('.prose');
      const hasProseContent = await proseDiv.count() > 0;

      if (hasProseContent) {
        const proseText = await proseDiv.textContent();
        if (proseText && proseText.trim().length > 5) {
          responseText = proseText.trim();

          // Check if still streaming (wait a bit and see if text is still growing)
          await page.waitForTimeout(3000);
          const newProseText = await proseDiv.textContent();
          if (newProseText === proseText) {
            // Text stopped growing, response is complete
            console.log(`Response received after ${Math.round((Date.now() - startTime)/1000)}s`);
            break;
          } else {
            responseText = newProseText?.trim() || responseText;
            console.log(`Still streaming... (${responseText.length} chars so far)`);
          }
        }
      }
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`Waiting... ${elapsed}s elapsed`);
}

if (responseText) {
  console.log('\n=== SUDO-AI RESPONSE ===');
  console.log(responseText);
  console.log('=== END RESPONSE ===\n');
} else {
  console.log('\nNo response text captured. Taking screenshot for visual inspection...');

  // Try a broader text extraction as fallback
  try {
    const chatArea = page.locator('[role="log"]').first();
    const allText = await chatArea.textContent();
    if (allText) {
      console.log('\n--- Chat area raw text ---');
      console.log(allText.trim().substring(0, 5000));
      console.log('--- End raw text ---');
    }
  } catch (e) {
    console.log('Fallback extraction failed:', e.message);
  }
}

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/skills-created.png', fullPage: false });
console.log('Screenshot saved to /root/sudo-ai-v3/screenshots/skills-created.png');
await browser.close();
