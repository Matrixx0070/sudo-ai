#!/usr/bin/env node
// Kitchen Mein Mat Aana — Full Production Pipeline
// Generates 8 scene images, voiceover, and assembles YouTube Short

import { execSync, spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load API keys
const envPath = '/root/sudo-ai-v3/config/.env';
const envContent = readFileSync(envPath, 'utf-8');
const XAI_API_KEY = envContent.match(/^XAI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!XAI_API_KEY) throw new Error('XAI_API_KEY not found in config/.env');

const OUTPUT_DIR = __dirname;
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');
const AUDIO_DIR = path.join(OUTPUT_DIR, 'audio');
const TEMP_DIR = path.join(OUTPUT_DIR, 'temp');

// ============================================================
// STORY: "Kitchen Mein Mat Aana"
// Genre: Family drama, betrayal, redemption
// Target: India/Pakistan audience, Hinglish
// ============================================================

const STORY = {
  title: "Kitchen Mein Mat Aana 🍳👑",
  hookLine: "Unhone kaha tha — kitchen mein mat aana.",
  ctaQuestion: "Kya Priya ne sahi kiya? Comment mein batao! 💬",
  cast: {
    protagonist: {
      name: "Priya",
      appearance: "24-year-old Indian woman, warm brown skin, large expressive dark brown eyes, thick black hair in a long braid, gentle round face, small nose, natural beauty",
    },
    antagonist: {
      name: "Saas (Mother-in-law)",
      appearance: "55-year-old Indian woman, stern sharp features, gray-streaked hair pulled back tight in a bun, thin lips, piercing dark eyes, heavy gold jewelry, imposing presence",
    }
  },
  scenes: [
    {
      index: 1,
      narration: "Unhone kaha tha — kitchen mein mat aana. Aaj main apni kitchen ki queen hoon.",
      description: "HOOK — Close-up of Priya's face in her grand modern restaurant kitchen. She wears a chef's white coat with her name embroidered. Stainless steel kitchen gleams behind her. Her eyes are fierce and proud with a hint of tears.",
      dallePrompt: "Cinematic close-up portrait of a 24-year-old Indian woman chef in a pristine white chef coat with 'PRIYA' embroidered in gold, standing in a gleaming modern professional restaurant kitchen with stainless steel equipment. She has warm brown skin, large expressive dark brown eyes glistening with proud tears, thick black hair in a neat braid. Her expression is fierce and triumphant. Dramatic warm golden lighting from above, shallow depth of field, bokeh lights in background. Photorealistic, cinematic color grading, 9:16 vertical portrait orientation, ultra detailed, 8K quality.",
      textOverlay: "Kitchen mein mat aana... 🍳"
    },
    {
      index: 2,
      narration: "Shaadi ke baad jab main sasural aayi, sapne the hazaaron.",
      description: "Flashback — Priya as a new bride in red wedding lehenga entering the in-laws' house. She's smiling, hopeful, carrying a small steel thali. The house is a traditional middle-class Indian home with warm lights.",
      dallePrompt: "Beautiful 24-year-old Indian bride in traditional red and gold wedding lehenga with dupatta over her head, mehndi on hands, carrying a small steel thali, stepping through the decorated entrance of a traditional middle-class Indian home. Warm fairy lights and marigold garlands frame the doorway. Her expression is hopeful and radiant with a gentle smile. Golden warm lighting, dreamy soft focus background, rose petals on the floor. Photorealistic, cinematic, warm color palette, 9:16 vertical portrait, ultra detailed, 8K quality.",
      textOverlay: ""
    },
    {
      index: 3,
      narration: "Lekin saas ne pehle din hi clear kar diya — yeh kitchen mera hai, tum mat aana.",
      description: "The mother-in-law stands blocking the kitchen doorway with one hand on the door frame. Her face is stern and cold. Behind her the kitchen is visible. Priya stands to the side, still in her bridal outfit, looking shocked and hurt.",
      dallePrompt: "Dramatic scene in a traditional Indian home hallway. A stern 55-year-old Indian mother-in-law with gray-streaked hair in a tight bun, heavy gold jewelry, wearing an expensive dark green silk saree, stands blocking the kitchen doorway with one hand firmly on the door frame, her expression cold and authoritative. A young Indian bride in red lehenga stands to the side looking shocked and hurt, her eyes wide with disbelief. The kitchen behind the mother-in-law has warm light spilling out. Harsh directional lighting creates dramatic shadows. Photorealistic, cinematic tension, 9:16 vertical, ultra detailed, 8K quality.",
      textOverlay: "Yeh kitchen MERA hai."
    },
    {
      index: 4,
      narration: "Raat ko akele room mein phone pe recipes dekhti thi. Aankhen bheegi, par hausla pakka.",
      description: "Night scene — Priya sits alone on a simple bed in a small room, lit only by the glow of her phone screen showing cooking videos. Tears streak her face but her expression is determined. A small notebook and pen lie beside her.",
      dallePrompt: "Intimate night scene of a young 24-year-old Indian woman sitting alone on a simple bed in a small dimly lit room, her face illuminated only by the blue-white glow of a smartphone screen showing cooking tutorial videos. She has tears streaking down her brown cheeks but her dark eyes show fierce determination. She wears a simple cotton salwar kameez. A small notebook and pen lie beside her on the bed. Moonlight filters through a small window. Moody blue and warm phone-glow lighting, emotional cinematic portrait. Photorealistic, 9:16 vertical, ultra detailed, 8K quality.",
      textOverlay: ""
    },
    {
      index: 5,
      narration: "Chupke chupke tiffin banana shuru kiya. Pehle 5 customers, phir 50.",
      description: "Priya in a tiny makeshift cooking space (a corner of her room with a small stove), carefully packing food into steel tiffin boxes. Multiple tiffins are lined up. She wears a simple apron over her kurta. Her face shows quiet pride.",
      dallePrompt: "Young 24-year-old Indian woman in a simple blue kurta with a handmade cloth apron, carefully packing delicious-looking Indian food into steel tiffin boxes in a tiny makeshift kitchen corner of a small room. A single gas burner stove, spice jars, and a cutting board are visible. Multiple tiffin boxes are neatly lined up on a small table, ready for delivery. Steam rises from freshly cooked food. Her expression shows quiet pride and determination. Warm golden cooking light, cozy atmosphere. Photorealistic, cinematic, 9:16 vertical, ultra detailed, 8K quality.",
      textOverlay: "5 customers... phir 50 🔥"
    },
    {
      index: 6,
      narration: "Ek saal mein mera catering business lakhon ka ho gaya. Sab kehte the — Priya ka khaana magic hai.",
      description: "SUCCESS MONTAGE — Priya now stands confidently in front of HER OWN restaurant/catering kitchen. A banner reads 'PRIYA'S KITCHEN' in Hindi and English. Staff work behind her. She wears professional chef attire. Customers line up outside.",
      dallePrompt: "Triumphant wide shot of a confident 24-year-old Indian woman chef standing proudly in front of her own modern restaurant with a large illuminated sign reading 'PRIYA'S KITCHEN' in both Hindi and English. She wears a professional white chef coat and stands with arms crossed, beaming with pride. Behind her through glass windows, kitchen staff work busily. A line of eager customers stretches outside. The restaurant exterior has warm inviting golden lights. Evening time, city street backdrop. Photorealistic, cinematic success moment, warm triumphant lighting, 9:16 vertical, ultra detailed, 8K quality.",
      textOverlay: "PRIYA'S KITCHEN 👑"
    },
    {
      index: 7,
      narration: "Phir woh din aaya. Saas mere restaurant ke bahar khadi thi. Ghar ka paisa khatam ho gaya tha.",
      description: "The mother-in-law stands outside Priya's grand restaurant, looking defeated and small. She wears a faded saree, no gold jewelry anymore. Her posture is hunched, head slightly bowed. The restaurant's warm glow contrasts with her cold loneliness.",
      dallePrompt: "Emotional scene of a defeated 55-year-old Indian woman standing alone outside a grand illuminated restaurant at night. She wears a faded plain cotton saree, no jewelry, her gray hair loosely tied. Her posture is hunched and small, head slightly bowed in shame, eyes looking down. The warm golden glow of 'PRIYA'S KITCHEN' restaurant sign illuminates her from behind, creating a dramatic silhouette contrast between her poverty and the restaurant's success. Rain-wet pavement reflects the lights. Photorealistic, cinematic, emotional, moody blue-gold lighting, 9:16 vertical, ultra detailed, 8K quality.",
      textOverlay: ""
    },
    {
      index: 8,
      narration: "Maine unka haath pakda aur kaha — Aaiye, ab yeh kitchen humara hai. Kuch darvaze band hote hain taake hum apna ghar bana sakein.",
      description: "REDEMPTION — Priya gently holds her mother-in-law's hand, leading her through the restaurant kitchen door. Both have tears in their eyes. Warm light floods from the kitchen. The mother-in-law's expression shows shame turning to gratitude. Priya's shows compassion and strength.",
      dallePrompt: "Deeply emotional scene of a young 24-year-old Indian woman chef in white coat gently holding the hand of an elderly 55-year-old Indian woman in a faded saree, leading her through the warm glowing doorway of a professional restaurant kitchen. Both have tears in their eyes. The young woman's expression radiates compassion and quiet strength. The elderly woman's face shows shame dissolving into gratitude. Warm golden light floods from the kitchen doorway, enveloping both figures in a redemptive glow. Staff members watch from inside with respectful smiles. Photorealistic, cinematic, emotional climax, 9:16 vertical, ultra detailed, 8K quality.",
      textOverlay: "Ab yeh kitchen HUMARA hai. ❤️"
    }
  ]
};

// ============================================================
// STEP 1: Generate Images via OpenAI DALL-E
// ============================================================

async function generateImage(scene) {
  const imgPath = path.join(IMAGES_DIR, `scene_${scene.index}.png`);

  if (existsSync(imgPath)) {
    console.log(`  ✓ Scene ${scene.index} image already exists, skipping`);
    return imgPath;
  }

  console.log(`  🎨 Generating scene ${scene.index}: ${scene.description.slice(0, 60)}...`);

  const response = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-imagine-image',
      prompt: scene.dallePrompt + ' Vertical 9:16 portrait orientation.',
      n: 1,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`xAI Image API error for scene ${scene.index}: ${response.status} ${err}`);
  }

  const data = await response.json();

  if (data.data?.[0]?.url) {
    const imgResp = await fetch(data.data[0].url);
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
    writeFileSync(imgPath, imgBuffer);
  } else if (data.data?.[0]?.b64_json) {
    const imgBuffer = Buffer.from(data.data[0].b64_json, 'base64');
    writeFileSync(imgPath, imgBuffer);
  } else {
    throw new Error(`Unexpected xAI response for scene ${scene.index}: ${JSON.stringify(data).slice(0, 200)}`);
  }

  console.log(`  ✓ Scene ${scene.index} saved: ${imgPath}`);
  return imgPath;
}

async function generateAllImages() {
  console.log('\n🎬 STEP 1: Generating 8 scene images via DALL-E...\n');

  // Generate 2 at a time to avoid rate limits
  for (let i = 0; i < STORY.scenes.length; i += 2) {
    const batch = STORY.scenes.slice(i, i + 2);
    await Promise.all(batch.map(scene => generateImage(scene)));
    if (i + 2 < STORY.scenes.length) {
      console.log('  ⏳ Brief pause between batches...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log('\n✅ All 8 scene images generated!\n');
}

// ============================================================
// STEP 2: Generate Voiceover via edge-tts
// ============================================================

async function generateVoiceover() {
  console.log('🎤 STEP 2: Generating Hinglish voiceover via edge-tts...\n');

  // Generate individual scene audio files
  const sceneAudioFiles = [];

  for (const scene of STORY.scenes) {
    const audioPath = path.join(AUDIO_DIR, `scene_${scene.index}.mp3`);
    const srtPath = path.join(AUDIO_DIR, `scene_${scene.index}.srt`);
    sceneAudioFiles.push(audioPath);

    if (existsSync(audioPath)) {
      console.log(`  ✓ Scene ${scene.index} audio already exists, skipping`);
      continue;
    }

    // Clean narration text for TTS
    const cleanText = scene.narration
      .replace(/\[pause\]/g, '...')
      .replace(/<whisper>(.*?)<\/whisper>/g, '$1');

    console.log(`  🎙️ Scene ${scene.index}: "${cleanText.slice(0, 50)}..."`);

    // Use Hindi female voice - hi-IN-SwaraNeural is excellent for Hinglish
    execSync(
      `edge-tts --voice "hi-IN-SwaraNeural" --rate="-5%" --pitch="+0Hz" --text "${cleanText.replace(/"/g, '\\"')}" --write-media "${audioPath}" --write-subtitles "${srtPath}"`,
      { timeout: 30000 }
    );

    console.log(`  ✓ Scene ${scene.index} audio saved`);
  }

  // Concatenate all scene audio with small gaps
  console.log('\n  🔗 Concatenating all scene audio...');

  // Generate a 0.4s silence gap
  const silencePath = path.join(TEMP_DIR, 'silence.mp3');
  execSync(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t 0.4 -q:a 9 -acodec libmp3lame "${silencePath}"`, { timeout: 10000 });

  // Build concat list
  const concatList = path.join(TEMP_DIR, 'audio_concat.txt');
  let concatContent = '';
  for (let i = 0; i < sceneAudioFiles.length; i++) {
    concatContent += `file '${sceneAudioFiles[i]}'\n`;
    if (i < sceneAudioFiles.length - 1) {
      concatContent += `file '${silencePath}'\n`;
    }
  }
  writeFileSync(concatList, concatContent);

  const fullAudioPath = path.join(AUDIO_DIR, 'full_narration.mp3');
  execSync(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -acodec libmp3lame -q:a 2 "${fullAudioPath}"`, { timeout: 30000 });

  // Get duration
  const durationStr = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fullAudioPath}"`, { timeout: 10000 }).toString().trim();
  const totalDuration = parseFloat(durationStr);
  console.log(`\n✅ Full narration generated: ${totalDuration.toFixed(1)}s\n`);

  return { fullAudioPath, totalDuration, sceneAudioFiles };
}

// ============================================================
// STEP 3: Generate Subtitles (ASS format for styling)
// ============================================================

function generateSubtitles(totalDuration) {
  console.log('📝 STEP 3: Generating styled subtitles...\n');

  const sceneDuration = totalDuration / STORY.scenes.length;

  // Build ASS subtitle file
  let ass = `[Script Info]
Title: Kitchen Mein Mat Aana
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,384,1
Style: Overlay,Arial,58,&H00FFFFFF,&H000000FF,&H00000000,&HC0000000,-1,0,0,0,100,100,0,0,3,4,2,2,60,60,200,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (const scene of STORY.scenes) {
    const startSec = (scene.index - 1) * sceneDuration;
    const endSec = scene.index * sceneDuration;

    const startTime = formatASSTime(startSec);
    const endTime = formatASSTime(endSec);

    // Narration subtitle
    const cleanNarration = scene.narration
      .replace(/\[pause\]/g, '')
      .replace(/<whisper>(.*?)<\/whisper>/g, '$1')
      .trim();

    ass += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${cleanNarration}\n`;

    // Text overlay if present
    if (scene.textOverlay) {
      const overlayStart = formatASSTime(startSec + 0.3);
      const overlayEnd = formatASSTime(endSec - 0.2);
      ass += `Dialogue: 1,${overlayStart},${overlayEnd},Overlay,,0,0,0,,${scene.textOverlay}\n`;
    }
  }

  const assPath = path.join(TEMP_DIR, 'subtitles.ass');
  writeFileSync(assPath, ass);
  console.log(`  ✓ Subtitles written: ${assPath}\n`);
  return assPath;
}

function formatASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// ============================================================
// STEP 4: Assemble Final Video
// ============================================================

async function assembleVideo(totalDuration, assPath) {
  console.log('🎬 STEP 4: Assembling final 9:16 YouTube Short...\n');

  const sceneDuration = totalDuration / 8;
  const fullAudioPath = path.join(AUDIO_DIR, 'full_narration.mp3');
  const outputPath = path.join(OUTPUT_DIR, 'kitchen-mein-mat-aana-FINAL.mp4');

  // Build ffmpeg filter complex for Ken Burns effect on images
  let inputs = '';
  let filterParts = [];
  let concatInputs = '';

  for (let i = 0; i < 8; i++) {
    const imgPath = path.join(IMAGES_DIR, `scene_${i + 1}.png`);
    inputs += `-loop 1 -t ${sceneDuration.toFixed(3)} -i "${imgPath}" `;

    // Ken Burns: slow zoom in or pan with fade transitions
    const zoomStart = 1.0;
    const zoomEnd = i % 2 === 0 ? 1.08 : 1.0;
    const xExpr = i % 2 === 0 ? `'iw/2-(iw/zoom/2)'` : `'iw/2-(iw/zoom/2)+20*t/${sceneDuration}'`;
    const yExpr = `'ih/2-(ih/zoom/2)'`;
    const zoomExpr = `'${zoomStart}+${((zoomEnd - zoomStart) / sceneDuration).toFixed(6)}*on/25'`;

    filterParts.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,zoompan=z=${zoomExpr}:x=${xExpr}:y=${yExpr}:d=${Math.ceil(sceneDuration * 25)}:s=1080x1920:fps=25,setsar=1,fade=t=in:st=0:d=0.3,fade=t=out:st=${(sceneDuration - 0.3).toFixed(3)}:d=0.3[v${i}]`
    );
    concatInputs += `[v${i}]`;
  }

  // Audio input (index 8)
  inputs += `-i "${fullAudioPath}" `;

  const filterComplex = filterParts.join(';\n') +
    `;\n${concatInputs}concat=n=8:v=1:a=0[vout]`;

  const filterPath = path.join(TEMP_DIR, 'filter.txt');
  writeFileSync(filterPath, filterComplex);

  // Build ffmpeg command
  const cmd = `ffmpeg -y ${inputs} -filter_complex_script "${filterPath}" -map "[vout]" -map 8:a -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k -r 25 -pix_fmt yuv420p -shortest -movflags +faststart "${outputPath}"`;

  console.log('  🔧 Running ffmpeg assembly (this may take 1-2 minutes)...');

  try {
    execSync(cmd, { timeout: 300000, stdio: 'pipe' });
  } catch (e) {
    console.error('  ⚠️ Complex filter failed, trying simpler approach...');
    return assembleVideoSimple(totalDuration, assPath);
  }

  // Now burn in subtitles
  console.log('  📝 Burning in subtitles...');
  const finalPath = path.join(OUTPUT_DIR, 'Kitchen_Mein_Mat_Aana_FINAL.mp4');
  execSync(
    `ffmpeg -y -i "${outputPath}" -vf "ass=${assPath}" -c:v libx264 -preset medium -crf 18 -c:a copy -movflags +faststart "${finalPath}"`,
    { timeout: 300000, stdio: 'pipe' }
  );

  console.log(`\n✅ Final video: ${finalPath}\n`);
  return finalPath;
}

async function assembleVideoSimple(totalDuration, assPath) {
  console.log('  🔧 Using simple slideshow approach...');

  const sceneDuration = totalDuration / 8;
  const fullAudioPath = path.join(AUDIO_DIR, 'full_narration.mp3');

  // Create a concat file for slideshow
  const slideshowList = path.join(TEMP_DIR, 'slideshow.txt');
  let slideshowContent = '';
  for (let i = 1; i <= 8; i++) {
    slideshowContent += `file '${path.join(IMAGES_DIR, `scene_${i}.png`)}'\n`;
    slideshowContent += `duration ${sceneDuration.toFixed(3)}\n`;
  }
  // Need to add last image again for ffmpeg concat demuxer
  slideshowContent += `file '${path.join(IMAGES_DIR, 'scene_8.png')}'\n`;
  writeFileSync(slideshowList, slideshowContent);

  const rawVideoPath = path.join(TEMP_DIR, 'raw_slideshow.mp4');
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${slideshowList}" -i "${fullAudioPath}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,fps=25" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k -pix_fmt yuv420p -shortest -movflags +faststart "${rawVideoPath}"`,
    { timeout: 300000, stdio: 'pipe' }
  );

  // Burn subtitles
  const finalPath = path.join(OUTPUT_DIR, 'Kitchen_Mein_Mat_Aana_FINAL.mp4');
  execSync(
    `ffmpeg -y -i "${rawVideoPath}" -vf "ass=${assPath}" -c:v libx264 -preset medium -crf 18 -c:a copy -movflags +faststart "${finalPath}"`,
    { timeout: 300000, stdio: 'pipe' }
  );

  console.log(`\n✅ Final video (simple): ${finalPath}\n`);
  return finalPath;
}

// ============================================================
// STEP 5: Quality Gate
// ============================================================

function qualityGate(videoPath) {
  console.log('🔍 STEP 5: Running quality gate...\n');

  const checks = [];

  // Get video info
  const probeJson = execSync(
    `ffprobe -v error -print_format json -show_format -show_streams "${videoPath}"`,
    { timeout: 10000 }
  ).toString();
  const probe = JSON.parse(probeJson);

  const videoStream = probe.streams.find(s => s.codec_type === 'video');
  const audioStream = probe.streams.find(s => s.codec_type === 'audio');
  const duration = parseFloat(probe.format.duration);
  const fileSize = parseInt(probe.format.size);

  // Resolution check (1080x1920)
  const resOk = videoStream && videoStream.width === 1080 && videoStream.height === 1920;
  checks.push({ name: 'Resolution 1080x1920', pass: resOk, detail: `${videoStream?.width}x${videoStream?.height}` });

  // Duration check (25-60s for shorts)
  const durOk = duration >= 15 && duration <= 60;
  checks.push({ name: 'Duration 15-60s', pass: durOk, detail: `${duration.toFixed(1)}s` });

  // Audio present
  const audioOk = !!audioStream;
  checks.push({ name: 'Audio track present', pass: audioOk, detail: audioStream?.codec_name || 'none' });

  // File size under 500MB
  const sizeOk = fileSize < 500 * 1024 * 1024;
  checks.push({ name: 'File size < 500MB', pass: sizeOk, detail: `${(fileSize / 1024 / 1024).toFixed(1)}MB` });

  // Scene count (8 images should exist)
  let sceneCount = 0;
  for (let i = 1; i <= 8; i++) {
    if (existsSync(path.join(IMAGES_DIR, `scene_${i}.png`))) sceneCount++;
  }
  checks.push({ name: '8 scene images', pass: sceneCount === 8, detail: `${sceneCount}/8` });

  // 9:16 aspect ratio
  const aspectOk = videoStream && Math.abs((videoStream.height / videoStream.width) - (1920/1080)) < 0.01;
  checks.push({ name: '9:16 aspect ratio', pass: aspectOk, detail: `${videoStream?.width}:${videoStream?.height}` });

  console.log('  Quality Gate Results:');
  console.log('  ─────────────────────────');
  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? '✅' : '❌';
    console.log(`  ${icon} ${c.name}: ${c.detail}`);
    if (!c.pass) allPass = false;
  }
  console.log('  ─────────────────────────');
  console.log(allPass ? '  ✅ ALL CHECKS PASSED' : '  ❌ SOME CHECKS FAILED');

  return { allPass, checks, duration, fileSize };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  🎬 Kitchen Mein Mat Aana — Production  ║');
  console.log('║  YouTube Short • 9:16 • Hinglish        ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Save story plan
  writeFileSync(
    path.join(OUTPUT_DIR, 'story-plan.json'),
    JSON.stringify(STORY, null, 2)
  );
  console.log('📋 Story plan saved to story-plan.json\n');

  // Step 1: Generate images
  await generateAllImages();

  // Step 2: Generate voiceover
  const { totalDuration } = await generateVoiceover();

  // Step 3: Generate subtitles
  const assPath = generateSubtitles(totalDuration);

  // Step 4: Assemble video
  const videoPath = await assembleVideo(totalDuration, assPath);

  // Step 5: Quality gate
  const qg = qualityGate(videoPath);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  📊 PRODUCTION COMPLETE                  ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Duration: ${qg.duration.toFixed(1)}s`);
  console.log(`║  Size: ${(qg.fileSize / 1024 / 1024).toFixed(1)}MB`);
  console.log(`║  Quality: ${qg.allPass ? 'ALL PASS ✅' : 'ISSUES FOUND ❌'}`);
  console.log(`║  Output: ${videoPath}`);
  console.log('╚══════════════════════════════════════════╝\n');

  process.exit(qg.allPass ? 0 : 1);
}

main().catch(err => {
  console.error('\n💥 PRODUCTION FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
