/**
 * Scene 1: Kitchen Mein Mat Aana
 * Grok image generation via CDP/Playwright
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { chromium } = require('/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');

const BASE = '/root/sudo-ai-v3/data/video/kitchen-mein-mat-aana';
const REFS = `${BASE}/references`;
const CLIPS = `${BASE}/clips`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Scene 1 image prompt — still frame, then we generate video from it
const SCENE1_IMAGE_PROMPT = `Photorealistic cinematic still, 9:16 vertical portrait orientation. Indian drama scene. Medium shot, slightly low angle. A 45-year-old South Asian woman (fair skin, visible face powder, heavy-set, wide hips) with dyed black hair styled loose, wearing bright magenta silk kameez with heavy gold embroidery, matching churidar, thick gold chain necklace, large gold jhumka earrings, gold nose pin left side, 8-10 gold bangles per wrist, dark red lipstick — stands in a kitchen doorway, one hand on the door frame, smirking, one eyebrow raised, looking down. Inside the dim kitchen: a 35-year-old South Asian woman with tired face, grey-streaked hair under off-white frayed dupatta, faded green patched salwar kameez, glass bangles, cooking at a single gas burner. On the floor: a 9-year-old South Asian girl with two tight black braids with red ribbons, large dark eyes, faded yellow salwar kameez, sits reading a tattered book. Single dim hanging bulb. The wealthy woman's gold jewelry glints. Moody cinematic lighting, shallow depth of field, dramatic tension. Bollywood drama aesthetic.`;

async function connectToGrok() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  for (const ctx of browser.contexts()) {
    for (const pg of ctx.pages()) {
      if (pg.url().includes('x.com/i/grok')) {
        console.log('Connected to Grok tab');
        return { browser, page: pg };
      }
    }
  }
  // Open Grok in new tab
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto('https://x.com/i/grok', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  return { browser, page };
}

async function generateImage(page, prompt) {
  console.log('Generating image...');

  // Click "Create Images" button to enter image mode
  try {
    await page.click('button:has-text("Create Images")', { timeout: 5000 });
    console.log('Clicked Create Images');
    await sleep(1000);
  } catch (e) {
    console.log('No Create Images button, typing direct prompt');
  }

  // Type in textarea
  const textarea = page.locator('textarea[placeholder="Ask anything"], textarea').first();
  await textarea.click({ timeout: 10000 });
  await sleep(300);

  // Clear and type
  await page.keyboard.press('Control+a');
  await sleep(100);
  await textarea.fill(prompt);
  await sleep(500);

  // Screenshot before submit
  await page.screenshot({ path: `${CLIPS}/debug-before-submit.png` });

  // Submit — try send button, then Enter
  try {
    // Look for send/submit button that appears when text is typed
    const sendBtn = page.locator('button[data-testid="sendButton"], button[aria-label*="Send"], button[aria-label*="send"]').first();
    await sendBtn.click({ timeout: 3000 });
    console.log('Clicked send button');
  } catch (e) {
    await page.keyboard.press('Enter');
    console.log('Pressed Enter to submit');
  }

  await sleep(2000);
  console.log('Prompt submitted, waiting for generation...');

  // Wait for image to appear — poll every 3s up to 3 min
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const elapsed = Math.round((Date.now() - (deadline - 180000)) / 1000);
    process.stdout.write(`\r  Waiting... ${elapsed}s`);

    // Check for generated image
    const imgCount = await page.locator('article img[src*="media"], article img[src*="blob"], [data-testid="tweetPhoto"] img').count();
    const hasMedia = await page.locator('img[src*="rsc="]').count(); // Grok image URLs
    const anyNewImg = await page.evaluate(() => {
      // Look for large images that appeared in the last response
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.filter(img => {
        const rect = img.getBoundingClientRect();
        const src = img.src || '';
        return rect.width > 200 && (src.includes('blob:') || src.includes('media') || src.includes('pbs.twimg') || src.includes('grok'));
      }).map(img => ({ src: img.src.substring(0, 100), w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) }));
    });

    if (anyNewImg.length > 0) {
      console.log(`\nFound images: ${JSON.stringify(anyNewImg)}`);
      await sleep(1000);
      return anyNewImg;
    }

    // Also check if there's an error message
    const errText = await page.evaluate(() => {
      const errorEls = document.querySelectorAll('[role="alert"], .error');
      return Array.from(errorEls).map(e => e.textContent.trim().slice(0, 100));
    });
    if (errText.length > 0) {
      throw new Error(`Grok error: ${errText.join(', ')}`);
    }
  }

  throw new Error('Image generation timed out');
}

async function saveGeneratedImage(page, savePath) {
  // Find the most recently generated image
  const imgData = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    // Get large images from the conversation
    const candidates = imgs.filter(img => {
      const rect = img.getBoundingClientRect();
      const src = img.src || '';
      return rect.width > 200 && src.length > 0;
    }).sort((a, b) => {
      // Sort by area, descending
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    return candidates.slice(0, 3).map(img => ({
      src: img.src,
      w: Math.round(img.getBoundingClientRect().width),
      h: Math.round(img.getBoundingClientRect().height)
    }));
  });

  console.log(`\nImage candidates: ${JSON.stringify(imgData)}`);

  if (imgData.length === 0) throw new Error('No image found to save');

  // Try to fetch and save the best candidate
  for (const img of imgData) {
    try {
      if (img.src.startsWith('data:')) {
        // data URI
        const base64 = img.src.split(',')[1];
        fs.writeFileSync(savePath, Buffer.from(base64, 'base64'));
        console.log(`Saved data URI image: ${savePath}`);
        return savePath;
      }

      // Fetch via browser context
      const buffer = await page.evaluate(async (src) => {
        try {
          const res = await fetch(src);
          if (!res.ok) return null;
          const ab = await res.arrayBuffer();
          return Array.from(new Uint8Array(ab));
        } catch (e) { return null; }
      }, img.src);

      if (buffer && buffer.length > 10000) {
        fs.writeFileSync(savePath, Buffer.from(buffer));
        console.log(`Saved image (${buffer.length} bytes): ${savePath}`);
        return savePath;
      }
    } catch (e) {
      console.log(`Failed to save ${img.src.slice(0, 60)}: ${e.message}`);
    }
  }

  // Fallback: screenshot the largest image element
  const imgEl = page.locator('img').last();
  await imgEl.screenshot({ path: savePath });
  console.log(`Saved screenshot fallback: ${savePath}`);
  return savePath;
}

async function main() {
  console.log('=== Scene 1: The Taunt — Image Generation ===\n');

  const { browser, page } = await connectToGrok();
  await page.bringToFront();

  // Initial screenshot
  await page.screenshot({ path: `${CLIPS}/debug-01-initial.png` });
  console.log('Initial screenshot saved');

  // Generate Scene 1 image
  await generateImage(page, SCENE1_IMAGE_PROMPT);

  // Wait a bit more for the image to fully render
  await sleep(3000);

  // Screenshot final state
  await page.screenshot({ path: `${CLIPS}/debug-02-after-gen.png`, fullPage: true });
  console.log('Post-generation screenshot saved');

  // Save the image
  const imagePath = `${CLIPS}/scene01.jpg`;
  await saveGeneratedImage(page, imagePath);

  // Take a final screenshot showing what we got
  await page.screenshot({ path: `${CLIPS}/debug-03-final.png`, fullPage: true });

  console.log(`\n✓ Scene 1 image saved: ${imagePath}`);
  console.log('Check clips/debug-02-after-gen.png to verify quality');

  process.exit(0);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
