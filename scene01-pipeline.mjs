/**
 * Scene 01 Pipeline — Kitchen Mein Mat Aana
 * Step 1: Grok image gen (portrait refs → scene still)
 * Step 2: Grok video gen (scene still → 6s clip)
 */

import { chromium } from '/root/sudo-ai-v3/node_modules/playwright-core/index.js';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFS = path.join(__dirname, 'data/video/kitchen-mein-mat-aana/references');
const OUT  = path.join(__dirname, 'output/kitchen-mein-mat-aana/scene01');
mkdirSync(OUT, { recursive: true });

// Scene 1 image prompt (condensed for image gen, character-focused)
const IMG_PROMPT = `Photorealistic still, Indian drama, moody cinematic. Medium shot low angle. Kitchen doorway scene: left — 45yo South Asian woman, fair powdered skin, heavy-set, dyed black blow-dried hair, bright magenta silk kameez with gold embroidery, thick gold necklace, large gold jhumka earrings, gold nose pin left, 8-10 gold bangles per wrist, thick kajal, dark red lips — one hand on door frame, smirking, eyebrow raised, looking down into kitchen. Center background — 35yo South Asian woman, tired face, grey-streaked hair under off-white frayed dupatta, faded green patched salwar kameez, glass bangles, stands at gas burner cooking. Floor — 9yo South Asian girl, two tight black braids with red ribbons, large dark eyes, faded yellow salwar kameez, thin black thread right wrist, sits reading tattered book propped on wall. Single dim hanging yellow bulb inside kitchen. Hallway behind wealthy woman is brighter — she's silhouetted with glinting gold. 9:16 vertical, shallow DOF, dramatic tension.`;

// Scene 1 full video prompt from storyboard
const VID_PROMPT = `Cinematic 5-second video clip, 9:16 vertical, photorealistic Indian drama. Medium shot, slightly low angle. A 45-year-old South Asian woman, fair skin with visible face powder, heavy-set build with wide hips, dyed black hair styled loose and blow-dried, wearing a bright magenta silk kameez with heavy gold embroidery at neck and sleeves, matching churidar, thick gold chain necklace, large gold jhumka earrings, gold nose pin on left side, 8-10 gold bangles per wrist, rings on 3 fingers of right hand, thick kajal on lower waterline, dark red lipstick — stands in a kitchen doorway with one hand firmly on the door frame, smirking with left corner of mouth pulled up, one eyebrow raised, chin tilted down. She looks into a small dim kitchen where a 35-year-old South Asian woman with tired face, dark circles, grey-streaked hair under an off-white frayed dupatta, wearing a faded green patched salwar kameez, glass bangles on wrists, stands at a single gas burner cooking. On the floor, a 9-year-old South Asian girl with two tight black braids with red ribbons, large dark brown eyes, wearing a faded yellow salwar kameez, sits with a tattered book propped against the wall. Single dim hanging bulb swings slightly. The wealthy woman's gold jewelry glints as she shifts her weight dismissively. Moody cinematic lighting, shallow depth of field, dramatic tension.`;

const PORTRAIT_FILES = [
  path.join(REFS, 'nasreen-aunty.jpg'),
  path.join(REFS, 'rukhsar-mother.jpg'),
  path.join(REFS, 'anaya-child.jpg'),
];

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

async function saveFromSrc(page, selector, outPath) {
  const src = await page.locator(selector).first().getAttribute('src');
  if (!src) throw new Error('No src found on ' + selector);
  log(`Fetching from src: ${src.slice(0,80)}...`);
  const data = await page.evaluate(async (url) => {
    const r = await fetch(url);
    const buf = await r.arrayBuffer();
    return [...new Uint8Array(buf)];
  }, src);
  writeFileSync(outPath, Buffer.from(data));
  log(`Saved: ${outPath}`);
}

async function run() {
  log('Connecting to CDP at localhost:9222...');
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();

  let page = pages.find(p => p.url().startsWith('https://grok.com'));
  if (!page) {
    page = await ctx.newPage();
  }

  // ─────────────────────────────────────────────────────
  // STEP 1 — IMAGE GENERATION
  // ─────────────────────────────────────────────────────
  log('STEP 1: Navigating to grok.com/imagine for IMAGE gen...');
  await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);

  // Switch to Image mode
  await page.click('button:has-text("Image")');
  await page.waitForTimeout(400);
  log('Switched to Image mode.');

  // Upload portrait references via hidden file input
  log('Uploading portrait references...');
  await page.locator('input[name="files"]').setInputFiles(PORTRAIT_FILES);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'step1a-refs.png') });

  // Type prompt into contenteditable div
  log('Typing image prompt...');
  const promptDiv = page.locator('div[contenteditable="true"]').first();
  await promptDiv.click();
  await promptDiv.fill(IMG_PROMPT);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'step1b-prompt.png') });

  // Submit
  log('Submitting image generation...');
  await page.click('button[aria-label="Submit"]');

  // Wait for generated image to appear — poll for post page or result img
  log('Waiting for image generation (up to 3 min)...');
  // Grok redirects to /imagine/post/<id> when done
  await page.waitForFunction(
    () => location.pathname.includes('/imagine/post/') || document.querySelector('img[src*="blob:"], img[src*="pbs.twimg"], img[src*="grok"]'),
    { timeout: 180000, polling: 2000 }
  );
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, 'step1c-result.png') });
  log('Image generated! Page: ' + page.url());

  // Save the generated image
  const imgOutPath = path.join(OUT, 'scene01-image.jpg');
  // Try download button first
  const dlBtn = page.locator('button[aria-label*="ownload"], a[download]').first();
  const dlExists = await dlBtn.count();
  if (dlExists > 0) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      dlBtn.click(),
    ]);
    await download.saveAs(imgOutPath);
    log('Downloaded via button: ' + imgOutPath);
  } else {
    // No download button — pick the largest visible <img> (the generated result,
    // not avatars/icons). `img:last-child` would match the wrong element.
    const bigSrc = await page.evaluate(() => {
      let best = null, bestArea = 0;
      for (const img of document.querySelectorAll('img')) {
        if (!img.src) continue;
        const r = img.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = img.src; }
      }
      return best;
    });
    if (!bigSrc) throw new Error('No result image found on page');
    log(`Fetching from src: ${bigSrc.slice(0,80)}...`);
    const data = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const buf = await r.arrayBuffer();
      return [...new Uint8Array(buf)];
    }, bigSrc);
    writeFileSync(imgOutPath, Buffer.from(data));
    log(`Saved: ${imgOutPath}`);
  }

  // ─────────────────────────────────────────────────────
  // STEP 2 — VIDEO GENERATION
  // ─────────────────────────────────────────────────────
  log('STEP 2: Navigating to grok.com/imagine for VIDEO gen...');
  await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);

  // Switch to Video mode
  await page.click('button:has-text("Video")');
  await page.waitForTimeout(600);

  // Set resolution and duration if controls appear
  await page.locator('text=720p').first().click({ timeout: 3000 }).catch(() => log('720p already set or not visible'));
  await page.locator('text=6s').first().click({ timeout: 3000 }).catch(() => log('6s already set or not visible'));
  await page.waitForTimeout(300);

  // Upload the generated scene image as reference
  log('Uploading scene image as video reference...');
  await page.locator('input[name="files"]').setInputFiles([imgOutPath]);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'step2a-ref.png') });

  // Type video prompt
  log('Typing video prompt...');
  const vidPromptDiv = page.locator('div[contenteditable="true"]').first();
  await vidPromptDiv.click();
  await vidPromptDiv.fill(VID_PROMPT);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'step2b-prompt.png') });

  // Submit
  log('Submitting video generation (2-5 minutes expected)...');
  await page.click('button[aria-label="Submit"]');

  // Wait for video element or download button
  log('Waiting for video generation (up to 5 min)...');
  await page.waitForFunction(
    () => document.querySelector('video') || location.pathname.includes('/imagine/post/'),
    { timeout: 300000, polling: 3000 }
  );
  // Wait a bit more for video to fully load
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, 'step2c-result.png') });
  log('Video generated! Page: ' + page.url());

  // Save the video
  const vidOutPath = path.join(OUT, 'scene01-video.mp4');
  const vidSrc = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) return v.src || v.querySelector('source')?.src || null;
    return null;
  });

  if (vidSrc && vidSrc.startsWith('http')) {
    const vidData = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const buf = await r.arrayBuffer();
      return [...new Uint8Array(buf)];
    }, vidSrc);
    writeFileSync(vidOutPath, Buffer.from(vidData));
    log('Video saved from src: ' + vidOutPath);
  } else if (vidSrc && vidSrc.startsWith('blob:')) {
    // blob URLs need special handling
    const vidData = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const buf = await r.arrayBuffer();
      return [...new Uint8Array(buf)];
    }, vidSrc);
    writeFileSync(vidOutPath, Buffer.from(vidData));
    log('Video saved from blob: ' + vidOutPath);
  } else {
    // Try download button
    const vidDlBtn = page.locator('a[download], button[aria-label*="ownload"], button:has-text("Download")').first();
    const vidDlExists = await vidDlBtn.count();
    if (vidDlExists > 0) {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        vidDlBtn.click(),
      ]);
      await dl.saveAs(vidOutPath);
      log('Video downloaded via button: ' + vidOutPath);
    } else {
      log('WARNING: Could not auto-download video. Check page: ' + page.url());
    }
  }

  log('\n=== SCENE 01 PIPELINE COMPLETE ===');
  log('Image: ' + imgOutPath);
  log('Video: ' + vidOutPath);

  await browser.close();
}

run().catch(e => {
  console.error('PIPELINE ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
});
