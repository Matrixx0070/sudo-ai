import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();

await page.goto('http://localhost:3001', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(3000);

const chatNav = page.locator('text=Chat').first();
if (await chatNav.isVisible()) await chatNav.click();
await page.waitForTimeout(2000);

const clearBtn = page.locator('text=Clear conversation').first();
if (await clearBtn.isVisible()) await clearBtn.click();
await page.waitForTimeout(1000);

const input = page.locator('#chat-input, textarea, input[placeholder*="Message"]').first();
await input.fill(`Listen SUDO. Here is exactly how you will generate the video for Kitchen Mein Mat Aana. 3 steps:

STEP 1: Generate CHARACTER IMAGES first. Use Grok Imagine to create a clear portrait of EACH character:
- Anaya child (age 9) — two braids, red ribbons, faded yellow kameez, big brown eyes
- Anaya doctor (age 25) — low bun, white lab coat, stethoscope, gold studs
- Rukhsar mother — dupatta, tired face, green kameez, glass bangles
- Nasreen aunty — magenta silk, gold jewelry everywhere, kajal, fair skin
Save all 4 to data/video/kitchen-mein-mat-aana/references/

STEP 2: Take those character reference images and GIVE THEM to Grok when creating each SCENE IMAGE. Open Grok on the web browser, UPLOAD the character image, and say "using this character, create this scene". This keeps the characters looking the SAME in every scene. Do this for all 8 scenes.

STEP 3: Take each scene image and GIVE IT to Grok web browser to generate a VIDEO CLIP. Upload the scene image and say "turn this image into a 5 second cinematic video clip with slow motion".

Start with STEP 1 now. Generate the 4 character portraits.`);
await input.press('Enter');

console.log('Message sent, waiting up to 10 minutes for response...');

// Poll for up to 10 minutes (120 iterations x 5 seconds)
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(5000);
  const hasResponse = await page.evaluate(() => {
    const msgs = document.querySelectorAll('article[aria-label="assistant message"] .prose, [class*="assistant"] [class*="prose"], [class*="message-content"], .prose');
    if (msgs.length === 0) return false;
    const last = msgs[msgs.length - 1];
    return last && last.textContent && last.textContent.length > 200;
  });
  if (hasResponse && i > 20) break;
  if (i % 12 === 0) console.log(`Still waiting... ${i*5}s elapsed`);
}

await page.evaluate(() => {
  const el = document.querySelector('[class*="messages"], main');
  if (el) el.scrollTop = el.scrollHeight;
});
await page.waitForTimeout(3000);

await page.screenshot({ path: '/root/sudo-ai-v3/screenshots/step1-characters.png', fullPage: false });

const text = await page.evaluate(() => {
  const selectors = ['article[aria-label="assistant message"] .prose', '.prose', '[class*="message-content"]'];
  for (const sel of selectors) {
    const msgs = document.querySelectorAll(sel);
    if (msgs.length > 0) return Array.from(msgs).map(m => m.textContent).join('\n---\n');
  }
  return document.body.innerText;
});
console.log('SUDO RESPONSE:\n' + text);

await browser.close();
