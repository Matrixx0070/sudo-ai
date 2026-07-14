/**
 * Scene 01 Video Generation via Sora (ChatGPT)
 * Uses existing logged-in browser session via CDP
 * Uploads scene01.jpg → generates 5s 9:16 clip → downloads
 */

import { chromium } from 'playwright-core';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLIPS_DIR = '/root/sudo-ai-v3/data/video/kitchen-mein-mat-aana/clips';
const SCENE01_IMG = join(CLIPS_DIR, 'scene01.jpg');
const OUTPUT_VIDEO = join(CLIPS_DIR, 'scene01_sora.mp4');
const SCREENSHOTS_DIR = join(CLIPS_DIR);

const SCENE01_PROMPT = `Cinematic 5-second video clip, 9:16 vertical, photorealistic Indian drama. Medium shot, slightly low angle. A 45-year-old South Asian woman, fair skin with visible face powder, heavy-set build with wide hips, dyed black hair styled loose and blow-dried, wearing a bright magenta silk kameez with heavy gold embroidery at neck and sleeves, matching churidar, thick gold chain necklace, large gold jhumka earrings, gold nose pin on left side, 8-10 gold bangles per wrist, rings on 3 fingers of right hand, thick kajal on lower waterline, dark red lipstick — stands in a kitchen doorway with one hand firmly on the door frame, smirking with left corner of mouth pulled up, one eyebrow raised, chin tilted down. She looks into a small dim kitchen where a 35-year-old South Asian woman with tired face, dark circles, grey-streaked hair under an off-white frayed dupatta, wearing a faded green patched salwar kameez, glass bangles on wrists, stands at a single gas burner cooking. On the floor, a 9-year-old South Asian girl with two tight black braids with red ribbons, large dark brown eyes, wearing a faded yellow salwar kameez, sits with a tattered book propped against the wall. Single dim hanging bulb swings slightly. The wealthy woman's gold jewelry glints as she shifts her weight dismissively. Moody cinematic lighting, shallow depth of field, dramatic tension.`;

function screenshot(page, name) {
  return page.screenshot({ path: join(CLIPS_DIR, `sora-${name}.png`), fullPage: false });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('Connecting to Chrome CDP on port 9222...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const context = contexts[0];

  // Open new tab for Sora
  console.log('Opening Sora...');
  const page = await context.newPage();

  // Try sora.com first (OpenAI's dedicated video gen)
  await page.goto('https://sora.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  await screenshot(page, '01-sora-load');

  const url = page.url();
  console.log('Current URL:', url);

  // Check if we're logged in or need to redirect
  const pageTitle = await page.title();
  console.log('Page title:', pageTitle);

  const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
  console.log('Body preview:', bodyText);

  await screenshot(page, '02-sora-state');

  // Check for login wall
  if (url.includes('login') || url.includes('auth') || bodyText?.toLowerCase().includes('log in') || bodyText?.toLowerCase().includes('sign in')) {
    console.log('Sora login wall detected. Trying chatgpt.com/sora instead...');
    await page.goto('https://chatgpt.com/sora', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);
    await screenshot(page, '03-chatgpt-sora');
    console.log('ChatGPT Sora URL:', page.url());
    const bodyText2 = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
    console.log('ChatGPT Sora body:', bodyText2);
  }

  await screenshot(page, '04-ready-state');

  // Look for the text input / prompt area
  console.log('Looking for Sora prompt input...');

  // Common Sora UI selectors
  const inputSelectors = [
    'textarea[placeholder*="Describe"]',
    'textarea[placeholder*="video"]',
    'textarea[placeholder*="prompt"]',
    '[contenteditable="true"]',
    'textarea',
    'input[type="text"]',
  ];

  let promptInput = null;
  for (const sel of inputSelectors) {
    try {
      const el = page.locator(sel).first();
      const count = await el.count();
      if (count > 0) {
        console.log(`Found input with selector: ${sel}`);
        promptInput = el;
        break;
      }
    } catch(e) {}
  }

  if (!promptInput) {
    console.log('Could not find prompt input. Dumping page structure...');
    const html = await page.evaluate(() => document.body?.innerHTML?.substring(0, 3000));
    console.log(html);
    await screenshot(page, '05-no-input-found');

    // Try clicking "Create" or "New video" button first
    const createBtns = page.locator('button:has-text("Create"), button:has-text("New"), a:has-text("Create")');
    const createCount = await createBtns.count();
    console.log(`Found ${createCount} create-type buttons`);
    if (createCount > 0) {
      await createBtns.first().click();
      await sleep(2000);
      await screenshot(page, '05b-after-create-click');
    }

    // Try again
    for (const sel of inputSelectors) {
      try {
        const el = page.locator(sel).first();
        const count = await el.count();
        if (count > 0) {
          console.log(`Found input after create click: ${sel}`);
          promptInput = el;
          break;
        }
      } catch(e) {}
    }
  }

  if (!promptInput) {
    console.error('FATAL: Cannot find prompt input on Sora. Manual inspection needed.');
    await browser.close();
    process.exit(1);
  }

  // Look for image upload button
  console.log('Looking for image upload button...');
  const uploadSelectors = [
    'input[type="file"]',
    'button[aria-label*="image"]',
    'button[aria-label*="upload"]',
    'button[aria-label*="attach"]',
    '[data-testid*="attach"]',
    '[data-testid*="upload"]',
  ];

  let fileInput = null;
  for (const sel of uploadSelectors) {
    try {
      const el = page.locator(sel).first();
      const count = await el.count();
      if (count > 0) {
        console.log(`Found file input: ${sel}`);
        fileInput = el;
        break;
      }
    } catch(e) {}
  }

  // Upload the scene image if file input found
  if (fileInput) {
    console.log('Uploading scene01.jpg as reference...');
    await fileInput.setInputFiles(SCENE01_IMG);
    await sleep(2000);
    await screenshot(page, '06-image-uploaded');
  } else {
    console.log('No file upload button found. Proceeding with text prompt only.');
    // Try clicking an image/attach icon
    const attachIcons = page.locator('button:has-text("Image"), button[title*="image"], svg[class*="attach"]');
    const attachCount = await attachIcons.count();
    if (attachCount > 0) {
      await attachIcons.first().click();
      await sleep(1000);
      // After click, check for file input
      const fi = page.locator('input[type="file"]').first();
      if (await fi.count() > 0) {
        await fi.setInputFiles(SCENE01_IMG);
        await sleep(2000);
        await screenshot(page, '06-image-uploaded-via-click');
      }
    }
  }

  // Type the prompt
  console.log('Typing scene prompt...');
  await promptInput.click();
  await sleep(500);
  await promptInput.fill(SCENE01_PROMPT);
  await sleep(1000);
  await screenshot(page, '07-prompt-typed');

  // Set aspect ratio to 9:16 if option exists
  console.log('Looking for aspect ratio / resolution settings...');
  const ratioSelectors = [
    'button:has-text("9:16")',
    'button:has-text("Portrait")',
    '[aria-label*="9:16"]',
    'select',
  ];
  for (const sel of ratioSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        console.log(`Found ratio control: ${sel}`);
        await el.click();
        await sleep(500);
        break;
      }
    } catch(e) {}
  }

  // Set duration to 5s if option exists
  const durationSelectors = [
    'button:has-text("5s")',
    'button:has-text("5 sec")',
    '[aria-label*="5 second"]',
  ];
  for (const sel of durationSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        console.log(`Found duration control: ${sel}`);
        await el.click();
        await sleep(500);
        break;
      }
    } catch(e) {}
  }

  await screenshot(page, '08-before-submit');

  // Submit
  console.log('Submitting video generation request...');
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Generate")',
    'button:has-text("Create")',
    'button[aria-label*="send"]',
    'button[aria-label*="submit"]',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        console.log(`Clicking submit: ${sel}`);
        await el.click();
        submitted = true;
        break;
      }
    } catch(e) {}
  }

  if (!submitted) {
    // Try Enter key
    console.log('No submit button found, trying Enter key...');
    await promptInput.press('Enter');
  }

  console.log('Submitted! Waiting for video generation (up to 3 minutes)...');
  await screenshot(page, '09-submitted');

  // Wait for video to appear
  let videoFound = false;
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    await screenshot(page, `10-progress-${(i+1)*5}s`);

    // Check for video element or download button
    const videoEl = page.locator('video').first();
    const downloadBtn = page.locator('a[download], button:has-text("Download"), a:has-text("Download")').first();

    const hasVideo = await videoEl.count() > 0;
    const hasDownload = await downloadBtn.count() > 0;

    console.log(`${(i+1)*5}s: video=${hasVideo}, download=${hasDownload}`);

    if (hasVideo || hasDownload) {
      videoFound = true;
      console.log('Video generation complete!');
      await screenshot(page, '11-video-ready');
      break;
    }
  }

  if (!videoFound) {
    console.log('Video not found after 3 minutes. Taking final screenshot.');
    await screenshot(page, '12-timeout');
    await browser.close();
    process.exit(1);
  }

  // Download the video
  console.log('Attempting to download video...');

  // Method 1: Click download button
  const downloadBtn = page.locator('a[download], button:has-text("Download"), [aria-label*="download"]').first();
  if (await downloadBtn.count() > 0) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      downloadBtn.click(),
    ]);
    const path = await download.path();
    const suggestedName = download.suggestedFilename();
    console.log(`Downloaded: ${suggestedName} from ${path}`);
    // Copy to output
    const { copyFileSync } = await import('fs');
    copyFileSync(path, OUTPUT_VIDEO);
    console.log(`Saved to: ${OUTPUT_VIDEO}`);
  } else {
    // Method 2: Get video src and download via fetch
    const videoSrc = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.src || v.currentSrc : null;
    });

    if (videoSrc) {
      console.log(`Video src: ${videoSrc}`);
      // Download using CDP
      const response = await page.request.get(videoSrc);
      const body = await response.body();
      writeFileSync(OUTPUT_VIDEO, body);
      console.log(`Saved ${body.length} bytes to: ${OUTPUT_VIDEO}`);
    } else {
      console.log('Could not find video src or download button.');
      await screenshot(page, '13-download-fail');
    }
  }

  // Verify output
  if (existsSync(OUTPUT_VIDEO)) {
    const { statSync } = await import('fs');
    const stat = statSync(OUTPUT_VIDEO);
    console.log(`\n✓ scene01_sora.mp4: ${stat.size} bytes`);
    if (stat.size < 10000) {
      console.log('WARNING: File is very small, may be corrupt');
    } else {
      console.log('SUCCESS: Video file looks valid');
    }
  }

  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
