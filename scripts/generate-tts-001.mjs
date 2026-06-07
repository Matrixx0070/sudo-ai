/**
 * generate-tts-001.mjs
 * TTS voiceover orchestrator for Video 001 — "AI Ne Meri Zindagi Barbad Kar Di"
 *
 * Provider cascade (stops at first success):
 *   1. ElevenLabs  — eleven_multilingual_v2, female voice (best for Hinglish)
 *   2. OpenAI      — tts-1, voice: nova
 *   3. Gemini      — gemini-2.5-flash-preview-tts, voice: Aoede (PCM → MP3 via ffmpeg)
 *
 * Output: data/pipeline/video-001/audio/narration.mp3
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  setLogger,
  generateElevenLabs,
  generateOpenAI,
  generateGemini,
} from "./tts-providers.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_PATH    = path.join(PROJECT_ROOT, "config", ".env");
const OUTPUT_PATH = path.join(
  PROJECT_ROOT,
  "data",
  "pipeline",
  "video-001",
  "audio",
  "narration.mp3"
);

// Narration text — Hinglish, Video 001
const NARRATION = `Mujhe handcuff tab laga jab main apne college ke baad ghar waapis aa rahi thi. Police ka kehna tha — AI ne mujhe pehchaan liya.

Main Priya hoon. 22 saal. Delhi ka ek middle-class ghar, caring family, aur ek roshan future. Meri engagement bhi hone waali thi Rahul se.

Phir ek raat, teen police officers hamare darwaze par aa gaye. Unhone kaha — Priya Sharma? Aap ek robbery case mein suspect hain. AI ne aapka chehra identify kiya hai. Mujhe woh jagah pata bhi nahi thi.

Mujhe station le gaye. Neighbours ne dekha. Papa bahar khade the — unki aankhon mein mujhse nafrat thi. Pura mohalla jaanta tha — Priya ko police le gayi.

Ek lawyer aaya. Usne kaha — AI systems galat bhi hote hain. Hum court mein ladhenge. Mujhe laga — shayad sab theek ho jaaye.

Lekin ghar se khabar aayi — Rahul ne rishta tod diya. Aur papa ne kaha — Tu meri beti nahi hai. AI ne meri zindagi barbad ki... aur mere apne logon ne dhakka diya.

Court mein sabit hua — AI galat tha. Real criminal alag thi — sirf chehra milta tha. Judge ne mujhe bari kar diya. Maa roti rahi. Papa maafi maang rahe the. Lekin main... main wahan nahi ruki.

Aaj main kisi ke liye nahi rukti — na family ke liye, na AI ke liye. Zindagi meri hai. Subscribe karo — aise aur sach'che AI horror stories ke liye.`;

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

function log(level, message, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta }));
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isKeyConfigured(key) {
  return (
    typeof key === "string" &&
    key.length > 10 &&
    key !== "configure-me" &&
    !key.includes("your-") &&
    !key.includes("-here")
  );
}

function estimateDurationSeconds(fileSizeBytes, bitrateKbps = 128) {
  return Math.round((fileSizeBytes * 8) / (bitrateKbps * 1000));
}

// ---------------------------------------------------------------------------
// Provider cascade
// ---------------------------------------------------------------------------

async function runCascade(keys) {
  const { elevenLabsKey, openAiKey, geminiKey } = keys;

  // 1. ElevenLabs
  if (isKeyConfigured(elevenLabsKey)) {
    try {
      const result = await generateElevenLabs(elevenLabsKey, NARRATION);
      log("info", "ElevenLabs TTS succeeded", { voice: result.voiceName });
      return result;
    } catch (err) {
      log("warn", "ElevenLabs failed — trying next provider", { error: err.message });
    }
  } else {
    log("warn", "ElevenLabs key not configured — skipping");
  }

  // 2. OpenAI
  if (isKeyConfigured(openAiKey)) {
    try {
      const result = await generateOpenAI(openAiKey, NARRATION);
      log("info", "OpenAI TTS succeeded", { voice: result.voiceName });
      return result;
    } catch (err) {
      log("warn", "OpenAI TTS failed — trying next provider", { error: err.message });
    }
  } else {
    log("warn", "OpenAI key not configured — skipping");
  }

  // 3. Gemini
  if (isKeyConfigured(geminiKey)) {
    try {
      const result = await generateGemini(geminiKey, NARRATION);
      log("info", "Gemini TTS succeeded", { voice: result.voiceName });
      return result;
    } catch (err) {
      log("error", "Gemini TTS also failed", { error: err.message });
      throw new Error(`All TTS providers exhausted. Last error: ${err.message}`);
    }
  } else {
    log("error", "Gemini key not configured — all providers exhausted");
    throw new Error("All TTS providers are unconfigured or failed");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("info", "TTS generation starting", { video: "video-001", outputPath: OUTPUT_PATH });

  // Load env
  if (!fs.existsSync(ENV_PATH)) {
    log("error", "Config .env not found", { path: ENV_PATH });
    process.exit(1);
  }
  dotenv.config({ path: ENV_PATH });

  // Wire logger into provider module
  setLogger(log);

  const keys = {
    elevenLabsKey : process.env.ELEVENLABS_API_KEY || "",
    openAiKey     : process.env.OPENAI_API_KEY     || "",
    geminiKey     : process.env.GEMINI_API_KEY     || "",
  };

  // Validate narration text
  if (!NARRATION || NARRATION.trim().length < 50) {
    log("error", "Narration text is empty or too short");
    process.exit(1);
  }
  log("info", "Narration validated", { chars: NARRATION.length });

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    log("info", "Creating output directory", { dir: outputDir });
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Run provider cascade
  let result;
  try {
    result = await runCascade(keys);
  } catch (err) {
    log("error", "TTS generation failed — all providers exhausted", { error: err.message });
    process.exit(1);
  }

  // Validate buffer before writing
  if (!Buffer.isBuffer(result.buffer) || result.buffer.length < 1024) {
    log("error", "Generated audio buffer is invalid or too small", {
      bytes: result.buffer?.length ?? 0,
    });
    process.exit(1);
  }

  // Write output file
  fs.writeFileSync(OUTPUT_PATH, result.buffer);
  log("info", "Output file written", { path: OUTPUT_PATH });

  // Stats
  const stat             = fs.statSync(OUTPUT_PATH);
  const fileSizeBytes    = stat.size;
  const fileSizeKB       = Math.round(fileSizeBytes / 1024);
  const estDuration      = estimateDurationSeconds(fileSizeBytes);

  log("info", "TTS generation complete", {
    provider             : result.provider,
    voiceName            : result.voiceName,
    outputPath           : OUTPUT_PATH,
    fileSizeBytes,
    fileSizeKB,
    estimatedDurationSecs: estDuration,
  });

  // Human-readable summary
  console.log("\n=== TTS GENERATION COMPLETE ===");
  console.log(`Provider     : ${result.provider.toUpperCase()}`);
  console.log(`Voice        : ${result.voiceName}`);
  console.log(`Output file  : ${OUTPUT_PATH}`);
  console.log(`File size    : ${fileSizeKB} KB (${fileSizeBytes} bytes)`);
  console.log(`Est. duration: ~${estDuration}s (~${Math.floor(estDuration / 60)}m ${estDuration % 60}s)`);
  console.log("================================\n");
}

main().catch((err) => {
  log("error", "Unhandled fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
