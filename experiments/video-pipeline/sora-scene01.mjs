/**
 * Sora Scene 01 Video Generation
 * Sora UI is already open at sora.com with scene01.jpg uploaded.
 * This script: sets 9:16 ratio → types prompt → submits → waits → downloads.
 */

import { chromium } from 'playwright-core';
import { writeFileSync, statSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { copyFileSync } from 'fs';

const CLIPS_DIR = '/root/sudo-ai-v3/data/video/kitchen-mein-mat-aana/clips';
const SCENE01_IMG = join(CLIPS_DIR, 'scene01.jpg');
const OUTPUT_VIDEO = join(CLIPS_DIR, 'scene01_sora.mp4');

const SCENE01_PROMPT = `Cinematic 5-second video clip, 9:16 vertical, photorealistic Indian drama. Medium shot, slightly low angle. A 45-year-old South Asian woman in bright magenta silk kameez with heavy gold embroidery, thick gold chain necklace, large gold jhumka earrings, 8-10 gold bangles per wrist, dark red lipstick — stands in a kitchen doorway with one hand firmly on the door frame, smirking, one eyebrow raised. She looks into a small dim kitchen where a 35-year-old South Asian woman with grey-streaked hair under off-white dupatta, faded green salwar kameez, stands at a gas burner cooking. A 9-year-old girl with two tight black braids with red ribbons sits on the kitchen floor with a tattered book. Single dim hanging bulb. Gold jewelry glints. Moody cinematic lighting, shallow depth of field, dramatic tension.`;

function ss(page, name) {
  return page.screenshot({ path: join(CLIPS_DIR, `s1-${name}.png`) });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('[sora-scene01] Connecting to CDP...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const pages = context.pages();

  // Find the Sora tab
  let soraPage = pages.find(p => p.url().includes('sora.com'));
  if (!soraPage) {
    console.log('[sora-scene01] No sora.com tab found, opening new one...');
    soraPage = await context.newPage();
    await soraPage.goto('https://sora.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
  }

  console.log('[sora-scene01] Sora tab URL:', soraPage.url());
  await ss(soraPage, '00-start');

  // --- STEP 1: Check if image already uploaded or upload fresh ---
  const existingImg = soraPage.locator('img[src*="blob"], img[src*="data:"]').first();
  const hasImg = await existingImg.count() > 0;
  console.log('[sora-scene01] Image already in UI:', hasImg);

  if (!hasImg) {
    console.log('[sora-scene01] Uploading scene01.jpg...');
    // Find file input
    const fileInput = soraPage.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(SCENE01_IMG);
      await sleep(2000);
      console.log('[sora-scene01] Image uploaded via file input');
    } else {
      // Try clicking the + button or attachment icon
      const plusBtn = soraPage.locator('button[aria-label*="image"], button[title*="image"], button:has-text("+")').first();
      if (await plusBtn.count() > 0) {
        await plusBtn.click();
        await sleep(1000);
        const fi2 = soraPage.locator('input[type="file"]').first();
        if (await fi2.count() > 0) {
          await fi2.setInputFiles(SCENE01_IMG);
          await sleep(2000);
        }
      }
    }
  }

  await ss(soraPage, '01-after-upload');

  // --- STEP 2: Set aspect ratio to 9:16 ---
  console.log('[sora-scene01] Setting aspect ratio to 9:16...');

  // Click the current ratio button (shows "1:1") to open dropdown
  const ratioBtn = soraPage.locator('button:has-text("1:1"), [aria-label*="aspect"], [aria-label*="ratio"]').first();
  if (await ratioBtn.count() > 0) {
    await ratioBtn.click();
    await sleep(800);
    await ss(soraPage, '02-ratio-dropdown');

    // Click 9:16 option
    const ratio916 = soraPage.locator('text="9:16", button:has-text("9:16"), [data-value="9:16"]').first();
    if (await ratio916.count() > 0) {
      await ratio916.click();
      await sleep(500);
      console.log('[sora-scene01] Set to 9:16');
    } else {
      // Try finding portrait option
      const portraitOpt = soraPage.locator('text="Portrait", text="Vertical"').first();
      if (await portraitOpt.count() > 0) {
        await portraitOpt.click();
        await sleep(500);
        console.log('[sora-scene01] Set to Portrait/Vertical');
      } else {
        console.log('[sora-scene01] WARNING: Could not find 9:16 option');
        // List all visible menu items
        const items = await soraPage.evaluate(() => {
          const allText = [];
          document.querySelectorAll('[role="menuitem"], [role="option"], li, [data-value]').forEach(el => {
            allText.push(el.textContent?.trim());
          });
          return allText.filter(Boolean);
        });
        console.log('[sora-scene01] Menu items:', items);
      }
    }
  } else {
    console.log('[sora-scene01] Ratio button not found, checking all buttons...');
    const allBtns = await soraPage.evaluate(() => {
      const btns = [];
      document.querySelectorAll('button').forEach(b => btns.push(b.textContent?.trim()?.substring(0, 50)));
      return btns.filter(Boolean);
    });
    console.log('[sora-scene01] All buttons:', allBtns.join(' | '));
  }

  await ss(soraPage, '03-after-ratio');

  // --- STEP 3: Verify duration is 5s ---
  console.log('[sora-scene01] Checking duration setting...');
  const dur5s = soraPage.locator('button:has-text("5s"), [aria-label*="5 sec"]').first();
  if (await dur5s.count() > 0) {
    console.log('[sora-scene01] Duration 5s confirmed');
  } else {
    // Click duration to check/set
    const durBtn = soraPage.locator('[aria-label*="duration"], button:has-text("10s"), button:has-text("15s")').first();
    if (await durBtn.count() > 0) {
      await durBtn.click();
      await sleep(500);
      const opt5s = soraPage.locator('text="5s", text="5 seconds"').first();
      if (await opt5s.count() > 0) {
        await opt5s.click();
        await sleep(300);
        console.log('[sora-scene01] Set duration to 5s');
      }
    }
  }

  // --- STEP 4: Type prompt ---
  console.log('[sora-scene01] Typing scene prompt...');
  const promptBox = soraPage.locator('textarea, [placeholder*="Describe"], [placeholder*="video"], [placeholder*="Optionally"]').first();
  if (await promptBox.count() > 0) {
    await promptBox.click();
    await sleep(300);
    // Clear existing text
    await promptBox.fill('');
    await sleep(200);
    await promptBox.fill(SCENE01_PROMPT);
    await sleep(500);
    console.log('[sora-scene01] Prompt typed');
  } else {
    console.log('[sora-scene01] WARNING: No textarea found');
    // Try contenteditable
    const ce = soraPage.locator('[contenteditable="true"]').first();
    if (await ce.count() > 0) {
      await ce.click();
      await ce.fill(SCENE01_PROMPT);
      await sleep(500);
    }
  }

  await ss(soraPage, '04-prompt-typed');

  // --- STEP 5: Submit ---
  console.log('[sora-scene01] Submitting...');

  // Try the arrow/submit button (top right of the input bar in Sora)
  const submitSelectors = [
    'button[type="submit"]',
    'button[aria-label*="generate"]',
    'button[aria-label*="submit"]',
    'button[aria-label*="create"]',
    'button[aria-label*="send"]',
    '[data-testid*="submit"]',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    const btn = soraPage.locator(sel).first();
    if (await btn.count() > 0) {
      const isEnabled = await btn.isEnabled();
      if (isEnabled) {
        console.log(`[sora-scene01] Clicking submit: ${sel}`);
        await btn.click();
        submitted = true;
        break;
      }
    }
  }

  if (!submitted) {
    // Sora uses an up-arrow button to submit
    // Try finding it by SVG or position
    const upArrow = soraPage.locator('button svg[class*="arrow"], button svg[class*="send"]').first();
    if (await upArrow.count() > 0) {
      await upArrow.click();
      submitted = true;
      console.log('[sora-scene01] Clicked up-arrow submit');
    } else {
      // Try pressing Enter in the textarea
      console.log('[sora-scene01] No submit button found, trying keyboard Enter...');
      await soraPage.keyboard.press('Enter');
      submitted = true;
    }
  }

  await sleep(2000);
  await ss(soraPage, '05-submitted');
  console.log('[sora-scene01] Request submitted. Waiting for generation (up to 5min)...');

  // --- STEP 6: Wait for video ---
  let videoReady = false;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);

    // Check for video element
    const videoEl = soraPage.locator('video').first();
    const hasVideo = await videoEl.count() > 0;

    // Check for download button
    const dlBtn = soraPage.locator('a[download], button:has-text("Download"), [aria-label*="download"]').first();
    const hasDl = await dlBtn.count() > 0;

    // Check for error states
    const errEl = soraPage.locator('text="failed", text="error", text="try again"').first();
    const hasErr = await errEl.count() > 0;

    console.log(`[sora-scene01] ${(i+1)*5}s: video=${hasVideo} download=${hasDl} error=${hasErr}`);

    if (i % 6 === 5) { // Every 30s take a screenshot
      await ss(soraPage, `06-progress-${(i+1)*5}s`);
    }

    if (hasVideo || hasDl) {
      videoReady = true;
      break;
    }

    if (hasErr) {
      console.log('[sora-scene01] ERROR detected on page');
      await ss(soraPage, '06-error');
      break;
    }
  }

  await ss(soraPage, '07-final-state');

  if (!videoReady) {
    console.log('[sora-scene01] Video not ready after timeout. Check sora-07-final-state.png');
    await browser.close();
    process.exit(1);
  }

  // --- STEP 7: Download video ---
  console.log('[sora-scene01] Video ready! Downloading...');

  // Method 1: Use download event via download button
  const dlBtn = soraPage.locator('a[download], button:has-text("Download"), [aria-label*="download"]').first();
  if (await dlBtn.count() > 0) {
    try {
      const [download] = await Promise.all([
        soraPage.waitForEvent('download', { timeout: 30000 }),
        dlBtn.click(),
      ]);
      const tmpPath = await download.path();
      const filename = download.suggestedFilename();
      console.log(`[sora-scene01] Downloaded: ${filename} (${tmpPath})`);
      copyFileSync(tmpPath, OUTPUT_VIDEO);
      console.log(`[sora-scene01] Saved to: ${OUTPUT_VIDEO}`);
    } catch(e) {
      console.log('[sora-scene01] Download event failed:', e.message);
    }
  }

  // Method 2: Get video src directly
  if (!existsSync(OUTPUT_VIDEO) || statSync(OUTPUT_VIDEO).size < 10000) {
    console.log('[sora-scene01] Trying video src extraction...');
    const videoSrc = await soraPage.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return v.src || v.currentSrc || (v.querySelector('source') && v.querySelector('source').src);
    });

    if (videoSrc && videoSrc.startsWith('http')) {
      console.log(`[sora-scene01] Video src: ${videoSrc.substring(0, 100)}...`);
      const resp = await soraPage.request.get(videoSrc);
      const buf = await resp.body();
      writeFileSync(OUTPUT_VIDEO, buf);
      console.log(`[sora-scene01] Saved ${buf.length} bytes to: ${OUTPUT_VIDEO}`);
    } else if (videoSrc && videoSrc.startsWith('blob:')) {
      console.log('[sora-scene01] Blob URL detected, using CDP to extract...');
      // Use CDP to fetch blob
      const b64 = await soraPage.evaluate(async (blobUrl) => {
        const res = await fetch(blobUrl);
        const buf = await res.arrayBuffer();
        const arr = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
        return btoa(binary);
      }, videoSrc);
      const buf = Buffer.from(b64, 'base64');
      writeFileSync(OUTPUT_VIDEO, buf);
      console.log(`[sora-scene01] Saved ${buf.length} bytes from blob to: ${OUTPUT_VIDEO}`);
    }
  }

  // --- Final check ---
  if (existsSync(OUTPUT_VIDEO)) {
    const size = statSync(OUTPUT_VIDEO).size;
    console.log(`\n[sora-scene01] OUTPUT: ${OUTPUT_VIDEO}`);
    console.log(`[sora-scene01] SIZE: ${size} bytes (${(size/1024/1024).toFixed(2)} MB)`);
    if (size > 100000) {
      console.log('[sora-scene01] ✓ SUCCESS: Video file looks valid');
    } else {
      console.log('[sora-scene01] ✗ WARNING: File may be corrupt (too small)');
    }
  } else {
    console.log('[sora-scene01] ✗ FAILED: No output file saved');
  }

  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('[sora-scene01] FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
