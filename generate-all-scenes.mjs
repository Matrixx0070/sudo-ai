/**
 * Full 8-scene pipeline for "Kitchen Mein Mat Aana"
 * 1. Generate scene image at x.com/i/grok
 * 2. Generate video at grok.com/imagine (Video mode, upload image)
 * 3. Download video via browser context (authenticated)
 */

import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');

const BASE = '/root/sudo-ai-v3/data/video/kitchen-mein-mat-aana';
const CLIPS = `${BASE}/clips`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// SCENE DEFINITIONS
// ============================================================
const SCENES = [
  {
    id: 1,
    imagePrompt: `Photorealistic cinematic still, 9:16 vertical portrait orientation. Indian drama scene. Medium shot, slightly low angle. A 45-year-old South Asian woman (fair skin, visible face powder, heavy-set, wide hips) with dyed black hair styled loose, wearing bright magenta silk kameez with heavy gold embroidery, matching churidar, thick gold chain necklace, large gold jhumka earrings, gold nose pin left side, 8-10 gold bangles per wrist, dark red lipstick — stands in a kitchen doorway, one hand on the door frame, smirking, one eyebrow raised, looking down. Inside the dim kitchen: a 35-year-old South Asian woman with tired face, grey-streaked hair under off-white frayed dupatta, faded green patched salwar kameez, glass bangles, cooking at a single gas burner. On the floor: a 9-year-old South Asian girl with two tight black braids with red ribbons, large dark eyes, faded yellow salwar kameez, sits reading a tattered book. Single dim hanging bulb. The wealthy woman's gold jewelry glints. Moody cinematic lighting, shallow depth of field, dramatic tension. Bollywood drama aesthetic.`,
    videoPrompt: `Cinematic 5-second video, 9:16 vertical, photorealistic Indian drama. Medium shot slightly low angle. A 45-year-old South Asian woman in bright magenta silk kameez with gold embroidery and heavy gold jewelry stands in a kitchen doorway, one hand on the door frame, smirking and looking down. Inside the dim kitchen: a tired 35-year-old South Asian woman in faded green salwar kameez with grey-streaked hair under off-white dupatta cooks at a gas burner. A 9-year-old girl with two tight black braids and red ribbons in a faded yellow salwar kameez sits on the floor reading a tattered book. The wealthy woman's gold bangles jangle as she shifts her weight. Single dim hanging bulb sways gently. Moody cinematic lighting, Bollywood drama style.`
  },
  {
    id: 2,
    imagePrompt: `Cinematic still, 9:16 vertical, photorealistic Indian drama. Close-up over-the-shoulder shot from behind a heavy-set 45-year-old South Asian woman in bright magenta silk kameez with gold embroidery, large gold jhumka earring visible, dyed black styled hair — she points one manicured finger with gold rings forward. In focus ahead: a 9-year-old South Asian girl sitting on a stone kitchen floor, two tight black braids with red ribbons, large dark brown almond-shaped eyes wide open with hurt, head tilted slightly, lips pressed together, faded yellow cotton salwar kameez, thin black thread on right wrist, tattered book in her small hands. Behind the child, a 35-year-old South Asian woman with grey-streaked hair under off-white dupatta, faded green salwar kameez, calloused hands frozen mid-chop on a stone counter, glass bangles on wrists, staring with worry. Single dim hanging bulb casts warm weak light. The wealthy woman's shadow falls across the child. Shallow depth of field, emotional cinematic lighting, dramatic.`,
    videoPrompt: `Cinematic 5-second video, 9:16 vertical, photorealistic Indian drama. Close-up over-the-shoulder from behind a heavy-set South Asian woman in magenta silk kameez with gold jhumka earring — she points one manicured finger forward. A 9-year-old South Asian girl on the kitchen floor looks up with large wounded eyes, two black braids with red ribbons, faded yellow salwar kameez, tattered book in hands. Behind her a tired mother with grey-streaked hair under dupatta freezes mid-chop. The wealthy woman's shadow falls across the child. Gold bangles jangle with the pointing gesture. Single dim bulb. Emotional, cruel, devastating moment. Shallow depth of field.`
  },
  {
    id: 3,
    imagePrompt: `Cinematic still, 9:16 vertical, photorealistic Indian drama. Low angle close-up at floor level in a small dim kitchen. A 35-year-old South Asian woman with tired face, deep-set dark brown eyes, grey-streaked black hair under off-white frayed dupatta, faded green cotton salwar kameez patched at one elbow, thin glass bangles 4 green and 2 red on both wrists — kneels on a stone floor. Her calloused hand cups the cheek of a 9-year-old South Asian girl with round face, large dark brown almond-shaped eyes glistening with held-back tears, two tight black braids with red ribbons, faded yellow salwar kameez, thin black thread on right wrist, clutching a tattered book to her chest. Their foreheads nearly touch. Behind them soft-focused: single gas burner with blue flame, steel utensils on stone counter, single hanging bulb casting a warm protective pool of light. Intimate, emotional, tender. Shallow depth of field, warm golden tones.`,
    videoPrompt: `Cinematic 5-second video, 9:16 vertical, photorealistic Indian drama. Low angle close-up at floor level. A tired 35-year-old South Asian mother in faded green salwar kameez with grey-streaked hair under off-white dupatta kneels and cups the cheek of her 9-year-old daughter with two black braids and red ribbons in faded yellow salwar kameez. Their foreheads nearly touch. The girl clutches a tattered book. The mother's glass bangles gently clink. The girl's eyes glisten with held-back tears. Gas burner hisses softly behind them. Warm protective pool of light from single bulb. Intimate, fierce, tender love. Warm golden cinematic tones.`
  },
  {
    id: 4,
    imagePrompt: `Cinematic still, 9:16 vertical, photorealistic Indian drama. Wide shot. Night scene. A 9-year-old South Asian girl with medium-warm brown skin, two tight black braids with red ribbons, large dark brown almond-shaped eyes narrowed in focus, jaw set with determination, wearing faded yellow cotton salwar kameez with sleeves rolled up, thin black thread on right wrist — sits cross-legged on the ground under a dim streetlight at night. An open textbook on her lap, small hands holding the book edges. A tattered notebook and pencil beside her. Behind her: a narrow dark street with closed shuttered shops, dark windows, sleeping neighborhood. She is the ONLY light source in the frame — the streetlight casts a warm orange cone around her while everything else is deep blue-black night. Her face is half-lit, red ribbons catching the glow. Moth circles the streetlight above. Cinematic, lonely, beautiful, determined. Deep shadows, warm-cool contrast.`,
    videoPrompt: `Cinematic 5-second video, 9:16 vertical, photorealistic Indian drama. Wide shot slowly pushing in. A 9-year-old South Asian girl with two tight black braids and red ribbons sits cross-legged under a dim streetlight at night, reading a textbook with fierce concentration. She is the only light in the frame — warm orange cone around her, deep blue-black night behind. Red ribbons catch the glow. Her jaw is set with determination. A moth circles the light above. Dead quiet neighborhood sleeps around her. The camera slowly pushes in toward her illuminated face. Lonely, beautiful, determined. Warm-cool contrast.`
  },
  {
    id: 5,
    imagePrompt: `Cinematic still, 9:16 vertical, photorealistic Indian drama. Medium close-up, straight-on composition. A 25-year-old South Asian woman with medium-warm brown skin, healthy glow, hair in a neat low bun, groomed slightly arched dark eyebrows, large dark brown eyes with a confident steady gaze, defined cheekbones, sharp pointed chin, calm assured closed-lip smile. She wears a crisp white knee-length lab coat buttoned over a light blue cotton kurta visible at the collar, silver stethoscope around her neck, small gold stud earrings, hospital ID badge clipped to left coat pocket, thin black thread (kala dhaga) visible on right wrist below the coat sleeve. She holds a patient file in her hands. A worn folded page peeks from her coat pocket. She stands in a bright modern hospital corridor with clean white walls and fluorescent lighting. Posture tall and upright, squared shoulders. Confident, triumphant, earned authority. Sharp focus on her face, slight corridor blur behind.`,
    videoPrompt: `Cinematic 5-second video, 9:16 vertical, photorealistic Indian drama. Medium close-up straight-on. A 25-year-old South Asian woman doctor in a crisp white lab coat with silver stethoscope around her neck stands in a bright hospital corridor. She holds a patient file. Her posture is perfect, shoulders squared. Her gaze is calm, steady, earned. A thin black thread is visible on her right wrist. Hospital sounds — soft beeps, distant PA. She takes a slow steady breath. The stethoscope catches the light as she shifts slightly. Bright blue-white fluorescent hospital lighting. Quiet triumph. Arrived.`
  },
  {
    id: 6,
    imagePrompt: `Cinematic still, 9:16 vertical, photorealistic Indian drama. Wide tracking shot angle in a narrow Indian neighborhood gali (alley). A 25-year-old South Asian woman with medium-warm brown skin, hair in a neat low bun, wearing a simple but elegant maroon salwar kameez, gold jhumka earrings, thin gold chain, thin black thread on right wrist, open-toe tan sandals — walks confidently down the center of the narrow street. Neighbors emerge from doorways staring in disbelief: women in colorful but simple saris, old men on charpoys, children frozen mid-play. Crumbling concrete walls, hanging wires, potted plants on windowsills. Late afternoon golden hour light floods the street with warm amber — dust particles visible in shafts of light between buildings. She almost glows in the golden light. In the deep background: a familiar small house door, slightly ajar. Cinematic, dramatic, emotional homecoming.`,
    videoPrompt: `Cinematic 5-second video, 9:16 vertical, photorealistic Indian drama. Wide tracking shot. A 25-year-old South Asian woman in elegant maroon salwar kameez walks confidently down a narrow Indian gali. Late afternoon golden hour floods the alley with warm amber — she almost glows. Neighbors emerge from doorways frozen in disbelief. Old men on charpoys stare. Children stop mid-play. Dust particles float in the shafts of light. Camera tracks from behind then swings to face her. A small familiar house door is ajar in the deep background. Murmuring "Rukhsar ki beti?" Emotional, triumphant homecoming.`
  },
  {
    id: 7,
    imagePrompt: `Cinematic still, 9:16 vertical, photorealistic Indian drama. Dramatic confrontation. Left of frame: a 45-year-old South Asian woman, fair skin with visible face powder lighter than her neck, heavy-set, dyed black hair styled loose, wearing a muted purple silk kameez, thick gold chain necklace, large gold jhumka earrings, gold nose pin left side, 8-10 gold bangles — thick kajal slightly smudged, dark red lipstick. Her mouth is open in shock, eyes wide, hand frozen mid-gesture, body leaning back slightly. Center-right: a 25-year-old South Asian woman in elegant maroon salwar kameez, gold jhumka earrings, thin gold chain, black thread on right wrist, hair in neat low bun — standing tall with steady confident gaze, chin level, slight closed-lip smile. Not gloating. Just present. Behind the young woman: a 35-year-old South Asian woman with grey-streaked hair under cream dupatta, wearing a clean white salwar kameez, glass bangles, standing in the doorway of a small house, hand over her mouth, eyes filled with tears. Golden hour lighting exposes the wealthy woman's face harshly while giving the young doctor a warm backlit halo.`,
    videoPrompt: `Cinematic 5-second video, 9:16 vertical, photorealistic Indian drama. Dramatic confrontation composition. Left: a heavy-set 45-year-old South Asian woman in purple silk kameez with gold jewelry — mouth open in shock, eyes wide, hand dropping, body leaning back. Center-right: a 25-year-old South Asian woman in maroon salwar kameez — standing tall, calm, steady gaze, not gloating, just present. Behind her in the doorway: a 35-year-old mother with hand over mouth, tears falling. The wealthy woman's gold bangles jangle once as her hand drops. The street falls silent for one breath. Golden hour exposes the older woman's face harshly. The young woman is backlit with a warm halo. Reversal. Power shift. Devastating quiet.`
  },
  {
    id: 8,
    imagePrompt: `Cinematic still, 9:16 vertical, photorealistic Indian drama. Emotional close-up at waist level. A 25-year-old South Asian woman with medium-warm brown skin, hair in neat low bun, wearing elegant maroon salwar kameez, gold jhumka earrings, thin gold chain, thin black thread visible on right wrist — kneels reaching toward the bare feet of a 35-year-old South Asian woman. The older woman has grey-streaked hair under a clean cream dupatta, wearing a clean white salwar kameez, glass bangles — 4 green, 2 red — on both wrists. The mother immediately pulls the daughter up with calloused hands. Both crying — the mother's lips trembling into a smile, eyes filled with tears she finally lets fall. The daughter's brows slightly raised, trembling smile, eyes glistening. They embrace in the same small kitchen — stone counter, steel utensils, gas burner — but now TWO hanging bulbs cast warm golden light instead of one. The extra light transforms the dim kitchen into a glowing sanctuary. Intimate, tender, cathartic. Warm golden tones.`,
    videoPrompt: `Cinematic 5-second video, 9:16 vertical, photorealistic Indian drama. Emotional close-up tilting up from waist level. A 25-year-old South Asian woman in maroon salwar kameez kneels reaching toward her mother's bare feet. The mother with grey-streaked hair under cream dupatta and glass bangles pulls her up immediately with calloused hands. Camera tilts up as they embrace tightly. The mother grips the back of her daughter's head — glass bangles press into her hair, the gentlest clink. Both crying — the mother's lips tremble into a smile, tears finally fall. The daughter's trembling smile, eyes glistening. Same kitchen but now TWO warm bulbs glow — the sanctuary they always deserved. Cathartic, complete, tender. Warm golden tones.`
  }
];

// ============================================================
// BROWSER HELPERS
// ============================================================
async function getGrokImagePage(ctx) {
  for (const pg of ctx.pages()) {
    if (pg.url().includes('x.com/i/grok')) return pg;
  }
  const page = await ctx.newPage();
  await page.goto('https://x.com/i/grok', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  return page;
}

async function getImaginePage(ctx) {
  for (const pg of ctx.pages()) {
    if (pg.url().includes('grok.com/imagine')) return pg;
  }
  const page = await ctx.newPage();
  await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  return page;
}

// ============================================================
// STEP 1: GENERATE IMAGE via x.com/i/grok
// ============================================================
async function generateSceneImage(ctx, scene) {
  const savePath = `${CLIPS}/scene${String(scene.id).padStart(2,'0')}.jpg`;
  if (fs.existsSync(savePath) && fs.statSync(savePath).size > 50000) {
    console.log(`  ↳ Image already exists: ${savePath}`);
    return savePath;
  }

  console.log(`  Generating image for Scene ${scene.id}...`);
  const page = await getGrokImagePage(ctx);
  await page.bringToFront();

  // Type prompt and submit
  const textarea = page.locator('textarea[placeholder="Ask anything"], textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 15000 });
  await textarea.click();
  await sleep(200);
  await page.keyboard.press('Control+a');
  await sleep(100);
  await textarea.fill(scene.imagePrompt);
  await sleep(300);
  await page.keyboard.press('Enter');
  await sleep(2000);

  // Wait for image
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const imgs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img')).filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.width > 200;
      }).map(img => img.src);
    });
    if (imgs.length > 0) {
      // Fetch and save
      for (const src of imgs) {
        try {
          const buffer = await page.evaluate(async (s) => {
            const res = await fetch(s, { credentials: 'include' });
            if (!res.ok) return null;
            const ab = await res.arrayBuffer();
            return Array.from(new Uint8Array(ab));
          }, src);
          if (buffer && buffer.length > 50000) {
            fs.writeFileSync(savePath, Buffer.from(buffer));
            console.log(`  ✓ Image saved: ${savePath} (${(buffer.length/1024).toFixed(0)}KB)`);
            return savePath;
          }
        } catch (e) { /* try next */ }
      }
    }
  }
  throw new Error(`Scene ${scene.id} image generation timed out`);
}

// ============================================================
// STEP 2: GENERATE VIDEO via grok.com/imagine
// ============================================================
async function generateSceneVideo(ctx, scene, imagePath) {
  const savePath = `${CLIPS}/scene${String(scene.id).padStart(2,'0')}.mp4`;
  if (fs.existsSync(savePath) && fs.statSync(savePath).size > 500000) {
    console.log(`  ↳ Video already exists: ${savePath}`);
    return savePath;
  }

  console.log(`  Generating video for Scene ${scene.id}...`);
  const page = await getImaginePage(ctx);
  await page.bringToFront();

  // Switch to Video mode
  const videoBtn = page.locator('button[role="radio"]:has-text("Video")');
  await videoBtn.waitFor({ state: 'visible', timeout: 10000 });
  if (await videoBtn.getAttribute('aria-checked') !== 'true') {
    await videoBtn.click();
    await sleep(1000);
  }

  // Upload reference image
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(imagePath);
  await sleep(2000);

  // Type prompt
  const input = page.locator('div[contenteditable="true"]').first();
  await input.click();
  await sleep(200);
  await page.keyboard.press('Control+a');
  await sleep(100);
  await input.fill(scene.videoPrompt);
  await sleep(300);

  // Submit
  const submitBtn = page.locator('button[aria-label="Submit"]');
  await submitBtn.click();
  await sleep(2000);

  // Wait for video
  console.log(`  Waiting for video (up to 6 min)...`);
  const deadline = Date.now() + 360000;
  let videoUrl = null;
  while (Date.now() < deadline) {
    await sleep(5000);
    const elapsed = Math.round((Date.now() - (deadline - 360000)) / 1000);
    process.stdout.write(`\r    ${elapsed}s...`);

    const videos = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('video'))
        .map(v => v.src || v.currentSrc || '')
        .filter(src => src.length > 10 && src.includes('http'));
    });

    if (videos.length > 0) {
      videoUrl = videos[0];
      console.log(`\n  Video ready at ${elapsed}s`);
      break;
    }
  }

  if (!videoUrl) throw new Error(`Scene ${scene.id} video generation timed out`);

  // Download using browser context (authenticated)
  const buffer = await page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Array.from(new Uint8Array(ab));
  }, videoUrl);

  if (buffer && buffer.length > 100000) {
    fs.writeFileSync(savePath, Buffer.from(buffer));
    console.log(`  ✓ Video saved: ${savePath} (${(buffer.length/1024/1024).toFixed(1)}MB)`);
    return savePath;
  }

  throw new Error(`Scene ${scene.id}: video download failed (${buffer?.length || 0} bytes)`);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  const startScene = parseInt(process.argv[2] || '1');
  console.log(`=== Kitchen Mein Mat Aana — Scenes ${startScene}-8 ===\n`);

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];

  for (const scene of SCENES) {
    if (scene.id < startScene) continue;

    console.log(`\n--- Scene ${scene.id} of 8 ---`);

    // Step 1: Image
    let imagePath;
    try {
      imagePath = await generateSceneImage(ctx, scene);
    } catch (e) {
      console.error(`  ✗ Image failed: ${e.message}`);
      continue;
    }

    // Step 2: Video
    try {
      await generateSceneVideo(ctx, scene, imagePath);
    } catch (e) {
      console.error(`  ✗ Video failed: ${e.message}`);
    }

    // Wait between scenes to avoid rate limits
    if (scene.id < 8) {
      console.log(`  Pausing 5s before next scene...`);
      await sleep(5000);
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  for (const scene of SCENES) {
    const id = String(scene.id).padStart(2,'0');
    const img = fs.existsSync(`${CLIPS}/scene${id}.jpg`) ? '✓' : '✗';
    const vid = fs.existsSync(`${CLIPS}/scene${id}.mp4`) ? '✓' : '✗';
    const vidSize = fs.existsSync(`${CLIPS}/scene${id}.mp4`) ?
      `${(fs.statSync(`${CLIPS}/scene${id}.mp4`).size/1024/1024).toFixed(1)}MB` : '-';
    console.log(`Scene ${scene.id}: img=${img} vid=${vid} (${vidSize})`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
