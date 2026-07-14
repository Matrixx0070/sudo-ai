/**
 * Scene 1: Generate video at grok.com/imagine
 * Selects Video mode, uploads scene01.jpg, submits prompt, downloads .mp4
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { chromium } = require('/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');

const BASE = '/root/sudo-ai-v3/data/video/kitchen-mein-mat-aana';
const CLIPS = `${BASE}/clips`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SCENE1_VIDEO_PROMPT = `Cinematic 5-second video, 9:16 vertical, photorealistic Indian drama. Medium shot slightly low angle. A 45-year-old South Asian woman in bright magenta silk kameez with gold embroidery and heavy gold jewelry stands in a kitchen doorway, one hand on the door frame, smirking and looking down. Inside the dim kitchen: a tired 35-year-old South Asian woman in faded green salwar kameez with grey-streaked hair under off-white dupatta cooks at a gas burner. A 9-year-old girl with two tight black braids and red ribbons in a faded yellow salwar kameez sits on the floor reading a tattered book. The wealthy woman's gold bangles jangle as she shifts her weight. Single dim hanging bulb sways gently. Moody cinematic lighting, Bollywood drama style.`;

async function getImagineTab(browser) {
  const ctx = browser.contexts()[0];
  // Look for existing grok.com/imagine tab
  for (const pg of ctx.pages()) {
    if (pg.url().includes('grok.com/imagine')) {
      console.log('Found existing grok.com/imagine tab');
      return pg;
    }
  }
  // Open it
  console.log('Opening grok.com/imagine...');
  const page = await ctx.newPage();
  await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  return page;
}

async function switchToVideoMode(page) {
  console.log('Switching to Video mode...');
  const videoBtn = page.locator('button[role="radio"]:has-text("Video")');
  await videoBtn.waitFor({ state: 'visible', timeout: 10000 });

  const isChecked = await videoBtn.getAttribute('aria-checked');
  if (isChecked === 'true') {
    console.log('Already in Video mode');
    return;
  }
  await videoBtn.click();
  await sleep(1000);

  const newChecked = await videoBtn.getAttribute('aria-checked');
  console.log(`Video mode active: ${newChecked === 'true'}`);
}

async function uploadReferenceImage(page, imagePath) {
  console.log(`Uploading reference: ${imagePath}`);

  // The Upload button triggers a file chooser
  const uploadBtn = page.locator('button[aria-label="Upload"]');
  await uploadBtn.waitFor({ state: 'visible', timeout: 10000 });

  // Try direct file input first (hidden input on the page)
  const fileInput = page.locator('input[type="file"]').first();
  const fileInputCount = await fileInput.count();

  if (fileInputCount > 0) {
    console.log('Using direct file input...');
    await fileInput.setInputFiles(imagePath);
  } else {
    // Fallback: file chooser via Upload button click
    console.log('Using file chooser via Upload button...');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      uploadBtn.click()
    ]);
    await fileChooser.setFiles(imagePath);
  }
  console.log('File selected, waiting for upload...');
  await sleep(3000);

  // Screenshot to verify upload
  await page.screenshot({ path: `${CLIPS}/debug-vid-01-uploaded.png` });
  console.log('Upload screenshot saved');
}

async function typePrompt(page, prompt) {
  console.log('Typing video prompt...');

  // The input is a contenteditable div
  const input = page.locator('div[contenteditable="true"]').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.click();
  await sleep(300);

  // Clear any existing content
  await page.keyboard.press('Control+a');
  await sleep(100);
  await page.keyboard.press('Delete');
  await sleep(100);

  // Type the prompt
  await input.fill(prompt);
  await sleep(500);

  console.log(`Prompt typed (${prompt.length} chars)`);
}

async function submit(page) {
  console.log('Submitting...');

  // Screenshot before submit
  await page.screenshot({ path: `${CLIPS}/debug-vid-02-before-submit.png` });

  const submitBtn = page.locator('button[aria-label="Submit"]');
  await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
  await submitBtn.click();

  console.log('Submitted!');
  await sleep(2000);
}

async function waitForVideoGeneration(page, timeoutMs = 360000) {
  console.log('Waiting for video generation (up to 6 min)...');
  const start = Date.now();
  const deadline = start + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(5000);
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  Generating... ${elapsed}s elapsed`);

    // Check for video elements on the page
    const videos = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('video')).map(v => ({
        src: v.src || '',
        currentSrc: v.currentSrc || '',
        w: Math.round(v.getBoundingClientRect().width),
        h: Math.round(v.getBoundingClientRect().height),
        readyState: v.readyState,
        duration: v.duration
      })).filter(v => v.w > 50);
    });

    if (videos.length > 0) {
      const withSrc = videos.filter(v => v.src.length > 0 || v.currentSrc.length > 0);
      if (withSrc.length > 0) {
        console.log(`\nVideo ready at ${elapsed}s: ${JSON.stringify(withSrc)}`);
        return withSrc;
      }
    }

    // Also check for blob URLs in the page
    const blobVideos = await page.evaluate(() => {
      const sources = Array.from(document.querySelectorAll('source, video')).map(el => el.src || el.srcObject?.id || '');
      return sources.filter(s => s.startsWith('blob:') || s.includes('.mp4'));
    });

    if (blobVideos.length > 0) {
      console.log(`\nBlob video found at ${elapsed}s:`, blobVideos);
      return blobVideos;
    }

    // Screenshot every 30s to track progress
    if (elapsed % 30 < 5) {
      await page.screenshot({ path: `${CLIPS}/debug-vid-progress-${elapsed}s.png` });
    }
  }

  throw new Error(`Video generation timed out after ${timeoutMs/1000}s`);
}

async function downloadGeneratedVideo(page, savePath) {
  console.log('\nDownloading video...');

  // Take screenshot of final state
  await page.screenshot({ path: `${CLIPS}/debug-vid-03-complete.png`, fullPage: false });

  // Get video src
  const videoInfo = await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    return videos.map(v => ({
      src: v.src,
      currentSrc: v.currentSrc,
      w: Math.round(v.getBoundingClientRect().width)
    })).filter(v => v.w > 50);
  });

  console.log('Video elements:', JSON.stringify(videoInfo));

  // Try fetching the video
  for (const vid of videoInfo) {
    const src = vid.currentSrc || vid.src;
    if (!src) continue;

    try {
      const buffer = await page.evaluate(async (url) => {
        const res = await fetch(url);
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        return Array.from(new Uint8Array(ab));
      }, src);

      if (buffer && buffer.length > 100000) {
        fs.writeFileSync(savePath, Buffer.from(buffer));
        const mb = (buffer.length / 1024 / 1024).toFixed(1);
        console.log(`Saved video (${mb}MB): ${savePath}`);
        return savePath;
      }
    } catch (e) {
      console.log(`Fetch failed for ${src.slice(0,60)}: ${e.message}`);
    }
  }

  // Try looking for download links
  const downloadLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).filter(a =>
      a.download || a.href.includes('.mp4') || a.href.includes('blob:')
    ).map(a => ({ href: a.href, download: a.download }));
  });

  if (downloadLinks.length > 0) {
    console.log('Download links found:', downloadLinks);
    // Try triggering download
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click(`a[href="${downloadLinks[0].href}"]`)
    ]);
    await download.saveAs(savePath);
    console.log(`Downloaded via link: ${savePath}`);
    return savePath;
  }

  throw new Error('Could not find video to download');
}

async function main() {
  console.log('=== Scene 1: Video Generation (grok.com/imagine) ===\n');

  const imagePath = `${CLIPS}/scene01.jpg`;
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Scene image not found: ${imagePath}. Run scene01-grok.mjs first.`);
  }
  console.log(`Source image: ${imagePath} (${(fs.statSync(imagePath).size/1024).toFixed(0)}KB)`);

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const page = await getImagineTab(browser);
  await page.bringToFront();

  // 1. Switch to Video mode
  await switchToVideoMode(page);

  // 2. Upload reference image
  await uploadReferenceImage(page, imagePath);

  // 3. Type prompt
  await typePrompt(page, SCENE1_VIDEO_PROMPT);

  // 4. Submit
  await submit(page);

  // 5. Wait for generation
  await waitForVideoGeneration(page, 360000);
  await sleep(3000);

  // 6. Download
  const videoPath = `${CLIPS}/scene01.mp4`;
  await downloadGeneratedVideo(page, videoPath);

  console.log(`\n✓ Scene 1 video: ${videoPath}`);

  process.exit(0);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  // Save error screenshot
  chromium.connectOverCDP('http://localhost:9222').then(async browser => {
    const ctx = browser.contexts()[0];
    for (const pg of ctx.pages()) {
      if (pg.url().includes('grok.com')) {
        await pg.screenshot({ path: `${CLIPS}/debug-vid-error.png`, fullPage: false });
        break;
      }
    }
  }).catch(() => {});
  process.exit(1);
});
