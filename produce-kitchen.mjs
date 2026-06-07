/**
 * "Kitchen Mein Mat Aana" — Full video production script
 * Generates 8 scene images, TTS narration, assembles into 9:16 YouTube Short
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Load .env manually
const envPath = '/root/sudo-ai-v3/config/.env';
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^([A-Z_]+)=(.+)$/);
  if (match) process.env[match[1]] = match[2].trim();
}

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const XAI_KEY = process.env.XAI_API_KEY;

// Reuse existing images if available from previous run
const PREV_RUN = 'kitchen-1774840242666';
const RUN_ID = `kitchen-${Date.now()}`;
const OUTPUT_BASE = `/root/sudo-ai-v3/data/media/${RUN_ID}`;
const IMAGES_DIR = `${OUTPUT_BASE}/images`;
const AUDIO_DIR = `${OUTPUT_BASE}/audio`;
const FINAL_DIR = `${OUTPUT_BASE}/final`;

for (const d of [IMAGES_DIR, AUDIO_DIR, FINAL_DIR]) {
  mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
// Story Plan
// ---------------------------------------------------------------------------

const STORY = {
  title: "Kitchen Mein Mat Aana 🔥",
  hookLine: "Saas ne bola tha — kitchen mein mat aana. Aaj woh MERI kitchen mein khadi hai.",
  ctaQuestion: "Aap hote toh kya bolte apni saas ko? Comment karo 💬",
  cast: {
    protagonist: {
      name: "Meera",
      role: "protagonist",
      appearance: "23-year-old Indian woman, warm brown skin, large expressive dark brown eyes, long thick black hair usually in a braid, gentle oval face, dimpled smile when happy",
      outfit_early: "Simple light green cotton salwar kameez, silver jhumka earrings, glass bangles, dupatta draped over shoulder, no makeup",
      outfit_later: "Elegant white chef coat with gold embroidery, hair tied in a professional bun with a fresh flower, minimal gold jewelry, confident posture"
    },
    antagonist: {
      name: "Savitri (Saas)",
      role: "antagonist",
      appearance: "55-year-old Indian woman, sharp features, thin pursed lips, heavy-lidded judgmental eyes, grey-streaked hair pulled into a tight bun, imposing posture",
      outfit_early: "Expensive maroon silk saree with gold border, heavy gold necklace and bangles, sindoor prominent, air of authority",
      outfit_later: "Same maroon saree but slightly faded, fewer gold bangles, posture diminished, looking smaller and older"
    }
  },
  narration: [
    "Saas ne bola tha — kitchen mein mat aana. ... Aaj woh MERI kitchen mein khadi hai.",
    "Shaadi ke baad, mujhe laga ghar mera bhi hai. ... Main kitni galat thi.",
    "Har roz taane. Khana achha nahi bana. Namak zyada hai. Chapati moti hai.",
    "Ek din usne mere haath se bartan chheen liya. ... Boli — tumse kuch nahi hoga.",
    "Pati ne bhi saath nahi diya. Bola — Maa ki baat maan lo. ... Kitchen mein mat aana.",
    "Main nikal gayi. ... Zero rupees, zero support. Sirf ek sapna — apna restaurant.",
    "3 saal baad, meri photo newspaper mein. ... Celebrity Chef Meera. Michelin Star.",
    "Aur ek din... woh aayi. Meri restaurant mein. ... Reservation maang rahi thi. Kya bolu main?"
  ],
  scenes: [
    {
      index: 1,
      narrationLine: "Saas ne bola tha — kitchen mein mat aana. Aaj woh MERI kitchen mein khadi hai.",
      emotionalBeat: "power reversal hook",
      dalleImagePrompt: "Cinematic extreme close-up of Meera, 23-year-old Indian woman with warm brown skin, large dark brown eyes filled with quiet triumph, long black hair in a professional bun with a white flower, wearing an elegant white chef coat with gold embroidery — she stands in a beautiful modern restaurant kitchen, warm golden lighting, stainless steel surfaces reflecting amber glow behind her, shallow depth of field. Photorealistic Indian drama style, cinematic lighting, masterpiece, 8K, 9:16 vertical portrait orientation.",
      textOverlay: "Kitchen mein mat aana..."
    },
    {
      index: 2,
      narrationLine: "Shaadi ke baad, mujhe laga ghar mera bhi hai. Main kitni galat thi.",
      emotionalBeat: "innocent hope crushed",
      dalleImagePrompt: "Wide shot of a traditional Indian joint family living room — Meera, 23-year-old Indian bride in simple light green salwar kameez with silver jhumkas and glass bangles, standing nervously at the threshold of a large traditional kitchen, holding a tray of chai cups, hopeful smile on her face — Savitri (55-year-old saas in expensive maroon silk saree with gold jewelry and tight grey hair bun) stands blocking the kitchen door with arms crossed, cold disapproving expression — warm tungsten lighting from old tube lights, traditional Indian home with marble floor and brass utensils visible. Photorealistic Indian drama style, cinematic, 8K, 9:16 vertical portrait.",
      textOverlay: "Naye ghar, naye sapne..."
    },
    {
      index: 3,
      narrationLine: "Har roz taane. Khana achha nahi bana. Namak zyada hai. Chapati moti hai.",
      emotionalBeat: "daily humiliation",
      dalleImagePrompt: "Medium shot of Indian kitchen scene — Meera in light green salwar kameez standing at a gas stove cooking, head slightly bowed, eyes red from crying — Savitri in maroon silk saree standing behind her pointing an accusatory finger at the food, face twisted in disgust, mouth open mid-criticism — the kitchen is a traditional Indian middle-class kitchen with steel vessels, spice jars, and a rolling board with chapatis — harsh overhead fluorescent light casting unflattering shadows. Photorealistic Indian drama style, emotional, cinematic, 8K, 9:16 vertical portrait.",
      textOverlay: "Har roz... har ek cheez mein kami."
    },
    {
      index: 4,
      narrationLine: "Ek din usne mere haath se bartan chheen liya. Boli — tumse kuch nahi hoga.",
      emotionalBeat: "breaking point",
      dalleImagePrompt: "Dramatic close-up action shot — Savitri's wrinkled hand aggressively snatching a steel cooking pot from Meera's hands, food spilling, Meera's shocked face visible in background with tears forming in her large dark brown eyes, her green dupatta slipping off her shoulder — traditional Indian kitchen, dal spilling on the marble floor, steam rising — dramatic low-angle lighting with harsh shadows. Photorealistic Indian drama style, high emotion, cinematic, 8K, 9:16 vertical portrait.",
      textOverlay: "Tumse kuch nahi hoga."
    },
    {
      index: 5,
      narrationLine: "Pati ne bhi saath nahi diya. Bola — Maa ki baat maan lo. Kitchen mein mat aana.",
      emotionalBeat: "ultimate betrayal",
      dalleImagePrompt: "Medium shot of an Indian bedroom at night — Meera sitting on the edge of a bed in her green salwar kameez, face in her hands, crying silently — her husband (30-year-old Indian man in a white vest and lungi) sitting on the other side of the bed with his back turned to her, scrolling his phone indifferently — a framed wedding photo of them smiling on the nightstand creates painful contrast — dim warm bedside lamp casting long sad shadows on pale walls. Photorealistic Indian drama style, emotionally devastating, cinematic, 8K, 9:16 vertical portrait.",
      textOverlay: "Pati ne bhi saath nahi diya."
    },
    {
      index: 6,
      narrationLine: "Main nikal gayi. Zero rupees, zero support. Sirf ek sapna — apna restaurant.",
      emotionalBeat: "rock bottom determination",
      dalleImagePrompt: "Cinematic wide shot — Meera walking alone on an empty rain-soaked Indian street at dawn, carrying a small cloth bag over her shoulder, wearing her now-wrinkled green salwar kameez, wet hair sticking to her face, no umbrella — she looks back one last time at the house behind her (blurred warm lights of the family home in background) — her face shows tears mixed with rain but her jaw is set with fierce determination — dramatic blue-orange dawn lighting, puddles reflecting neon signs. Photorealistic Indian drama style, powerful, cinematic, 8K, 9:16 vertical portrait.",
      textOverlay: "Zero support. Sirf ek sapna."
    },
    {
      index: 7,
      narrationLine: "3 saal baad, meri photo newspaper mein. Celebrity Chef Meera. Michelin Star.",
      emotionalBeat: "triumphant transformation",
      dalleImagePrompt: "Split composition — top half shows a newspaper front page with headline 'CELEBRITY CHEF MEERA WINS MICHELIN STAR' with her confident photo in white chef coat — bottom half shows Meera in her gorgeous modern restaurant kitchen, white chef coat with gold embroidery, hair in a bun with flower, commanding a team of chefs behind her, plating a beautiful dish with artistic precision — the restaurant is upscale with warm amber lighting, copper pans hanging, fresh herbs — she looks powerful, radiant, transformed. Photorealistic Indian drama style, triumphant, cinematic, 8K, 9:16 vertical portrait.",
      textOverlay: "Celebrity Chef Meera. ⭐ Michelin Star."
    },
    {
      index: 8,
      narrationLine: "Aur ek din woh aayi. Meri restaurant mein. Reservation maang rahi thi. Kya bolu main?",
      emotionalBeat: "confrontation and redemption",
      dalleImagePrompt: "Dramatic medium shot in an upscale restaurant lobby — Meera in her white chef coat with gold embroidery standing tall and composed behind the reception podium — Savitri (saas) in her now-faded maroon saree, looking smaller and older, standing on the other side nervously, hands clasped, eyes downcast with shame — between them on the podium sits a reservation book — the restaurant glows with warm amber lighting, elegant decor, other diners visible in soft focus background — the power dynamic is completely reversed. Photorealistic Indian drama style, emotionally charged climax, cinematic, 8K, 9:16 vertical portrait.",
      textOverlay: "Aap hote toh kya bolte? 💬 Comment karo!"
    }
  ]
};

// ---------------------------------------------------------------------------
// Step 1: Generate Scene Images (xAI Grok → Gemini fallback)
// ---------------------------------------------------------------------------

async function generateImageGrok(prompt, sceneIndex) {
  const response = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${XAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-imagine-image',
      prompt: prompt + ' Vertical 9:16 portrait composition.',
      n: 1,
      response_format: 'b64_json',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Grok image error: ${response.status} — ${body.slice(0, 300)}`);
  }

  const json = await response.json();
  const item = json.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const imgRes = await fetch(item.url);
    return Buffer.from(await imgRes.arrayBuffer());
  }
  throw new Error('Grok returned no image data');
}

async function generateImageGemini(prompt, sceneIndex) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  // Use Imagen 4.0 via Gemini API
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: '9:16',
        },
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini Imagen error: ${response.status} — ${body.slice(0, 300)}`);
  }

  const json = await response.json();
  const b64 = json.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('Gemini returned no image data');
  return Buffer.from(b64, 'base64');
}

async function generateImage(prompt, sceneIndex) {
  console.log(`🎨 Generating scene ${sceneIndex}/8...`);
  const startTime = Date.now();

  let imageBuffer;
  let provider;

  // Try Grok first, then Gemini, then OpenAI
  try {
    imageBuffer = await generateImageGrok(prompt, sceneIndex);
    provider = 'Grok';
  } catch (err) {
    console.log(`   ⚠️ Grok failed: ${err.message.slice(0, 80)}`);
    try {
      imageBuffer = await generateImageGemini(prompt, sceneIndex);
      provider = 'Gemini';
    } catch (err2) {
      console.log(`   ⚠️ Gemini failed: ${err2.message.slice(0, 80)}`);
      // Last resort: OpenAI
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size: '1024x1792', output_format: 'png', quality: 'high' }),
      });
      if (!response.ok) throw new Error(`All image providers failed for scene ${sceneIndex}`);
      const json = await response.json();
      const item = json.data?.[0];
      if (item?.b64_json) imageBuffer = Buffer.from(item.b64_json, 'base64');
      else if (item?.url) imageBuffer = Buffer.from(await (await fetch(item.url)).arrayBuffer());
      else throw new Error('All providers exhausted');
      provider = 'OpenAI';
    }
  }

  const filePath = `${IMAGES_DIR}/scene_${sceneIndex}.png`;
  writeFileSync(filePath, imageBuffer);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`   ✅ Scene ${sceneIndex} saved via ${provider} (${elapsed}s)`);
  return filePath;
}

async function generateAllImages() {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 1: GENERATING 8 SCENE IMAGES');
  console.log('══════════════════════════════════════════\n');

  const paths = {};

  // Check if images from previous run can be reused
  const prevImagesDir = `/root/sudo-ai-v3/data/media/${PREV_RUN}/images`;
  let allExist = true;
  for (let i = 1; i <= 8; i++) {
    if (!existsSync(`${prevImagesDir}/scene_${i}.png`)) { allExist = false; break; }
  }

  if (allExist) {
    console.log(`♻️ Reusing images from previous run: ${PREV_RUN}`);
    for (let i = 1; i <= 8; i++) {
      const src = `${prevImagesDir}/scene_${i}.png`;
      const dst = `${IMAGES_DIR}/scene_${i}.png`;
      execSync(`cp "${src}" "${dst}"`);
      paths[i] = dst;
      console.log(`   ✅ Scene ${i} copied`);
    }
    console.log(`\n✅ All 8 scene images ready (cached).\n`);
    return paths;
  }

  // Generate fresh images in pairs
  for (let i = 0; i < STORY.scenes.length; i += 2) {
    const batch = STORY.scenes.slice(i, i + 2);
    const results = await Promise.all(
      batch.map(scene => generateImage(scene.dalleImagePrompt, scene.index))
    );
    results.forEach((p, j) => { paths[batch[j].index] = p; });

    if (i + 2 < STORY.scenes.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n✅ All 8 scene images generated.\n`);
  return paths;
}

// ---------------------------------------------------------------------------
// Step 2: Generate TTS Narration (xAI)
// ---------------------------------------------------------------------------

async function generateVoice() {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 2: GENERATING TTS NARRATION');
  console.log('══════════════════════════════════════════\n');

  const fullScript = STORY.narration.join(' ... ');
  console.log(`📝 Script (${fullScript.length} chars): "${fullScript.slice(0, 100)}..."`);

  // Try xAI first, fallback to OpenAI
  let audioBuffer;
  let provider;
  const XAI_VOICE_KEY = process.env.XAI_VOICE_API_KEY || XAI_KEY;

  // Try xAI with dedicated voice key first
  const ttsAttempts = [
    { name: 'xAI (voice key)', url: 'https://api.x.ai/v1/audio/speech', key: XAI_VOICE_KEY, model: 'tts-1', voice: 'rex' },
    { name: 'xAI (main key)', url: 'https://api.x.ai/v1/audio/speech', key: XAI_KEY, model: 'tts-1', voice: 'rex' },
    { name: 'OpenAI', url: 'https://api.openai.com/v1/audio/speech', key: OPENAI_KEY, model: 'tts-1', voice: 'onyx' },
  ];

  for (const attempt of ttsAttempts) {
    try {
      console.log(`🎙️ Trying ${attempt.name}...`);
      const response = await fetch(attempt.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${attempt.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: attempt.model,
          input: fullScript,
          voice: attempt.voice,
          response_format: 'mp3',
          speed: 1.0,
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`${attempt.name} TTS: ${response.status} — ${errBody.slice(0, 150)}`);
      }

      audioBuffer = Buffer.from(await response.arrayBuffer());
      provider = attempt.name;
      break;
    } catch (err) {
      console.log(`   ⚠️ ${err.message}`);
    }
  }

  // If all API TTS failed, use espeak as last resort
  if (!audioBuffer) {
    console.log('🎙️ All API TTS failed. Using espeak + ffmpeg local TTS...');
    const tempWav = `${AUDIO_DIR}/narration_raw.wav`;
    // Use espeak-ng for local TTS
    try {
      execSync(`which espeak-ng || apt-get install -y espeak-ng 2>/dev/null`, { stdio: 'pipe' });
    } catch (e) {
      // try espeak
    }
    const escapedScript = fullScript.replace(/'/g, "'\\''");
    try {
      execSync(`espeak-ng -v en+m3 -s 140 -w "${tempWav}" '${escapedScript}'`, { stdio: 'pipe', timeout: 30000 });
    } catch (e) {
      execSync(`espeak -v en+m3 -s 140 -w "${tempWav}" '${escapedScript}'`, { stdio: 'pipe', timeout: 30000 });
    }
    // Convert to mp3
    execSync(`ffmpeg -y -i "${tempWav}" -codec:a libmp3lame -b:a 192k "${AUDIO_DIR}/narration.mp3"`, { stdio: 'pipe' });
    audioBuffer = readFileSync(`${AUDIO_DIR}/narration.mp3`);
    provider = 'espeak (local)';
  }

  const audioPath = `${AUDIO_DIR}/narration.mp3`;
  writeFileSync(audioPath, audioBuffer);
  console.log(`✅ Narration saved via ${provider} → ${audioPath}`);

  // Get duration
  const durationStr = execSync(
    `ffprobe -i "${audioPath}" -show_entries format=duration -v quiet -of csv="p=0"`,
    { encoding: 'utf-8' }
  ).trim();
  const duration = parseFloat(durationStr);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid narration duration from ffprobe: "${durationStr}"`);
  }
  console.log(`⏱️ Narration duration: ${duration.toFixed(1)}s`);

  return { audioPath, duration };
}

// ---------------------------------------------------------------------------
// Step 3: Generate SRT Subtitles
// ---------------------------------------------------------------------------

function generateSubtitles(totalDuration) {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 3: GENERATING SUBTITLES');
  console.log('══════════════════════════════════════════\n');

  const lines = STORY.narration.map(line =>
    line.replace(/\.\.\./g, '').replace(/\[pause\]/gi, '').replace(/<whisper>(.*?)<\/whisper>/gi, '$1').trim()
  );

  // Distribute time across narration lines proportionally by word count
  const totalWords = lines.reduce((sum, l) => sum + l.split(/\s+/).length, 0);
  let currentTime = 0;

  let srt = '';
  lines.forEach((line, i) => {
    const wordCount = line.split(/\s+/).length;
    const lineDuration = (wordCount / totalWords) * totalDuration;
    const startTime = currentTime;
    const endTime = currentTime + lineDuration;

    srt += `${i + 1}\n`;
    srt += `${formatSrtTime(startTime)} --> ${formatSrtTime(endTime)}\n`;
    srt += `${line}\n\n`;

    currentTime = endTime;
  });

  const srtPath = `${AUDIO_DIR}/subtitles.srt`;
  writeFileSync(srtPath, srt);
  console.log(`✅ Subtitles generated → ${srtPath}`);
  return srtPath;
}

function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Step 4: Assemble Final Video with FFmpeg
// ---------------------------------------------------------------------------

function assembleVideo(scenePaths, audioPath, srtPath, totalDuration) {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 4: ASSEMBLING FINAL VIDEO');
  console.log('══════════════════════════════════════════\n');

  const sceneCount = Object.keys(scenePaths).length;
  const sceneDuration = totalDuration / sceneCount;
  console.log(`📐 ${sceneCount} scenes × ${sceneDuration.toFixed(2)}s each = ${totalDuration.toFixed(1)}s total`);

  // Build FFmpeg filter for Ken Burns effect (subtle zoom/pan on each image)
  const inputs = [];
  const filterParts = [];

  for (let i = 1; i <= sceneCount; i++) {
    inputs.push(`-loop 1 -t ${sceneDuration.toFixed(3)} -i "${scenePaths[i]}"`);

    // Subtle Ken Burns: slow zoom from 100% to 110% with slight pan
    const zoomDir = i % 2 === 0 ? 'in' : 'out';
    const zoomStart = zoomDir === 'in' ? 1.0 : 1.1;
    const zoomEnd = zoomDir === 'in' ? 1.1 : 1.0;
    const fps = 30;
    const totalFrames = Math.ceil(sceneDuration * fps);

    filterParts.push(
      `[${i - 1}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,` +
      `zoompan=z='${zoomStart}+(${zoomEnd}-${zoomStart})*on/${totalFrames}':` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
      `d=${totalFrames}:s=1080x1920:fps=${fps},` +
      `setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=0.3,fade=t=out:st=${(sceneDuration - 0.3).toFixed(3)}:d=0.3` +
      `[v${i}]`
    );
  }

  // Concat all video streams
  const concatInputs = Array.from({ length: sceneCount }, (_, i) => `[v${i + 1}]`).join('');
  const filterComplex = filterParts.join('; ') +
    `; ${concatInputs}concat=n=${sceneCount}:v=1:a=0[vout]`;

  // Escape SRT path for FFmpeg subtitles filter
  const escapedSrt = srtPath.replace(/:/g, '\\:').replace(/'/g, "\\'");

  const outputPath = `${FINAL_DIR}/${RUN_ID}_final.mp4`;

  const cmd = [
    'ffmpeg -y',
    inputs.join(' '),
    `-i "${audioPath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]"`,
    `-map ${sceneCount}:a`,
    `-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p`,
    `-c:a aac -b:a 192k`,
    `-shortest`,
    `-movflags +faststart`,
    `"${outputPath}"`
  ].join(' \\\n  ');

  console.log('🔧 Running FFmpeg assembly...');
  console.log(`   Output: ${outputPath}`);

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 300000 });
    console.log('✅ Video assembled successfully!');
  } catch (err) {
    console.error('❌ FFmpeg failed. Trying simpler assembly without Ken Burns...');

    // Fallback: simple slideshow without zoompan
    const simpleConcatFile = `${OUTPUT_BASE}/concat.txt`;
    let concatContent = '';
    for (let i = 1; i <= sceneCount; i++) {
      concatContent += `file '${scenePaths[i]}'\n`;
      concatContent += `duration ${sceneDuration.toFixed(3)}\n`;
    }
    // Repeat last image to fix last-frame issue
    concatContent += `file '${scenePaths[sceneCount]}'\n`;
    writeFileSync(simpleConcatFile, concatContent);

    const simpleCmd = [
      'ffmpeg -y',
      `-f concat -safe 0 -i "${simpleConcatFile}"`,
      `-i "${audioPath}"`,
      `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30"`,
      `-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p`,
      `-c:a aac -b:a 192k`,
      `-shortest`,
      `-movflags +faststart`,
      `"${outputPath}"`
    ].join(' \\\n  ');

    execSync(simpleCmd, { stdio: 'pipe', timeout: 300000 });
    console.log('✅ Video assembled (simple mode)!');
  }

  // Now burn subtitles
  const withSubsPath = `${FINAL_DIR}/${RUN_ID}_with_subs.mp4`;
  console.log('🔤 Burning subtitles...');

  try {
    const subsCmd = [
      'ffmpeg -y',
      `-i "${outputPath}"`,
      `-vf "subtitles='${escapedSrt}':force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=80,Bold=1'"`,
      `-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p`,
      `-c:a copy`,
      `-movflags +faststart`,
      `"${withSubsPath}"`
    ].join(' \\\n  ');

    execSync(subsCmd, { stdio: 'pipe', timeout: 300000 });
    console.log(`✅ Subtitles burned → ${withSubsPath}`);

    // Replace original with subtitled version
    execSync(`mv "${withSubsPath}" "${outputPath}"`);
  } catch (err) {
    console.log(`⚠️ Subtitle burn failed (${err.message.slice(0, 100)}), keeping video without subs`);
  }

  return outputPath;
}

// ---------------------------------------------------------------------------
// Step 5: Quality Gate
// ---------------------------------------------------------------------------

function qualityGate(videoPath) {
  console.log('\n══════════════════════════════════════════');
  console.log('  STEP 5: QUALITY GATE');
  console.log('══════════════════════════════════════════\n');

  const checks = [];

  // Check file exists and size
  const sizeBytes = parseInt(execSync(`stat -c%s "${videoPath}"`, { encoding: 'utf-8' }).trim());
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  checks.push({ name: 'File size', value: `${sizeMB} MB`, pass: sizeBytes > 100000 && sizeBytes < 500 * 1024 * 1024 });

  // Check resolution
  const resolution = execSync(
    `ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${videoPath}"`,
    { encoding: 'utf-8' }
  ).trim();
  checks.push({ name: 'Resolution', value: resolution, pass: resolution === '1080x1920' });

  // Check duration
  const duration = parseFloat(execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`,
    { encoding: 'utf-8' }
  ).trim());
  checks.push({ name: 'Duration', value: `${duration.toFixed(1)}s`, pass: duration >= 15 && duration <= 60 });

  // Check has audio
  const audioStreams = execSync(
    `ffprobe -v quiet -select_streams a -show_entries stream=codec_name -of csv=p=0 "${videoPath}"`,
    { encoding: 'utf-8' }
  ).trim();
  checks.push({ name: 'Audio', value: audioStreams || 'NONE', pass: audioStreams.length > 0 });

  // Check codec
  const videoCodec = execSync(
    `ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${videoPath}"`,
    { encoding: 'utf-8' }
  ).trim();
  checks.push({ name: 'Video codec', value: videoCodec, pass: videoCodec === 'h264' });

  console.log('Quality Gate Results:');
  console.log('─────────────────────');
  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? '✅' : '❌';
    console.log(`  ${icon} ${c.name}: ${c.value}`);
    if (!c.pass) allPass = false;
  }

  console.log(`\n${allPass ? '✅ ALL CHECKS PASSED' : '⚠️ SOME CHECKS FAILED'}`);
  return allPass;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SUDO-AI VIDEO PRODUCTION                    ║');
  console.log('║  "Kitchen Mein Mat Aana" 🔥                  ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\nRun ID: ${RUN_ID}`);
  console.log(`Output: ${OUTPUT_BASE}\n`);

  const startTime = Date.now();

  // Step 1: Generate images
  const scenePaths = await generateAllImages();

  // Step 2: Generate voice
  const { audioPath, duration } = await generateVoice();

  // Step 3: Generate subtitles
  const srtPath = generateSubtitles(duration);

  // Step 4: Assemble video
  const videoPath = assembleVideo(scenePaths, audioPath, srtPath, duration);

  // Step 5: Quality gate
  const passed = qualityGate(videoPath);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n══════════════════════════════════════════`);
  console.log(`  PRODUCTION COMPLETE`);
  console.log(`  Time: ${elapsed} minutes`);
  console.log(`  Video: ${videoPath}`);
  console.log(`  Quality: ${passed ? 'PASSED ✅' : 'NEEDS REVIEW ⚠️'}`);
  console.log(`══════════════════════════════════════════\n`);

  // Save plan for reference
  writeFileSync(`${OUTPUT_BASE}/plan.json`, JSON.stringify(STORY, null, 2));
  console.log(`📋 Plan saved → ${OUTPUT_BASE}/plan.json`);

  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('\n💥 FATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});
