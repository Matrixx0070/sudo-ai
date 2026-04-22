/**
 * tts-providers.mjs
 * TTS provider implementations for Video 001 narration pipeline.
 *
 * Providers (tried in order by caller):
 *   1. ElevenLabs — eleven_multilingual_v2, female voice
 *   2. OpenAI     — tts-1, voice: nova
 *   3. Gemini     — gemini-2.5-flash-preview-tts, voice: Aoede (female)
 *                   Returns raw PCM → caller must convert to MP3 via ffmpeg
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ELEVENLABS_VOICE_PREFS = ["Priya", "Meera", "Rachel", "Bella", "Elli"];
const ELEVENLABS_MODEL       = "eleven_multilingual_v2";
const OPENAI_VOICE           = "nova";
const OPENAI_MODEL           = "tts-1";
const GEMINI_VOICE           = "Aoede"; // Female voice in Gemini TTS
const GEMINI_MODEL           = "gemini-2.5-flash-preview-tts";
const GEMINI_SAMPLE_RATE     = 24000;   // PCM sample rate returned by Gemini

// ---------------------------------------------------------------------------
// Shared logger (injected by caller)
// ---------------------------------------------------------------------------

let _log = (level, msg, meta) => console.log(`[${level}] ${msg}`, meta || "");

export function setLogger(logFn) {
  _log = logFn;
}

// ---------------------------------------------------------------------------
// Input validation helper
// ---------------------------------------------------------------------------

function assertApiKey(key, name) {
  if (!key || key.length < 10 || key === "configure-me" || key === "your-key-here") {
    throw new Error(`${name} API key is not configured or invalid`);
  }
}

function assertText(text) {
  if (!text || typeof text !== "string" || text.trim().length < 10) {
    throw new Error("TTS input text is empty or too short");
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

async function elevenLabsListVoices(apiKey) {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs list-voices HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return Array.isArray(data.voices) ? data.voices : [];
}

function pickElevenLabsVoice(voices) {
  for (const pref of ELEVENLABS_VOICE_PREFS) {
    const match = voices.find((v) => v.name?.toLowerCase() === pref.toLowerCase());
    if (match) return match;
  }
  const female = voices.find(
    (v) => v.labels?.gender === "female" || v.labels?.accent === "indian"
  );
  if (female) return female;
  if (voices.length > 0) return voices[0];
  throw new Error("ElevenLabs: no voices available");
}

export async function generateElevenLabs(apiKey, text) {
  assertApiKey(apiKey, "ElevenLabs");
  assertText(text);

  _log("info", "ElevenLabs: fetching available voices");
  const voices = await elevenLabsListVoices(apiKey);
  _log("info", "ElevenLabs: voices fetched", { count: voices.length });

  const voice = pickElevenLabsVoice(voices);
  _log("info", "ElevenLabs: voice selected", { name: voice.name, id: voice.voice_id });

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.voice_id}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
    }),
  });

  if (!res.ok) {
    throw new Error(`ElevenLabs TTS HTTP ${res.status}: ${await res.text()}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024) {
    throw new Error(`ElevenLabs returned suspiciously small audio: ${buffer.length} bytes`);
  }

  return { buffer, provider: "elevenlabs", voiceName: voice.name, format: "mp3" };
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export async function generateOpenAI(apiKey, text) {
  assertApiKey(apiKey, "OpenAI");
  assertText(text);

  _log("info", "OpenAI TTS: requesting audio", { voice: OPENAI_VOICE, model: OPENAI_MODEL });

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: text,
      voice: OPENAI_VOICE,
      response_format: "mp3",
      speed: 0.95,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI TTS HTTP ${res.status}: ${await res.text()}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024) {
    throw new Error(`OpenAI returned suspiciously small audio: ${buffer.length} bytes`);
  }

  return { buffer, provider: "openai", voiceName: OPENAI_VOICE, format: "mp3" };
}

// ---------------------------------------------------------------------------
// Gemini TTS  (returns PCM → converts to MP3 via ffmpeg)
// ---------------------------------------------------------------------------

async function geminiGeneratePcm(apiKey, text) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } },
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini TTS HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const audioPart = parts.find((p) => p.inlineData?.mimeType?.startsWith("audio/"));

  if (!audioPart) {
    throw new Error("Gemini TTS: no audio part in response");
  }

  const pcmBuffer = Buffer.from(audioPart.inlineData.data, "base64");
  if (pcmBuffer.length < 512) {
    throw new Error(`Gemini TTS returned suspiciously small PCM: ${pcmBuffer.length} bytes`);
  }

  return pcmBuffer;
}

function pcmToMp3(pcmBuffer, sampleRate) {
  // Write raw PCM to a temp file
  const tmpPcm = path.join(os.tmpdir(), `tts-gemini-${Date.now()}.pcm`);
  const tmpMp3 = path.join(os.tmpdir(), `tts-gemini-${Date.now()}.mp3`);

  try {
    fs.writeFileSync(tmpPcm, pcmBuffer);

    // ffmpeg: read 16-bit signed PCM, mono, 24kHz → encode to MP3 at 128kbps
    const cmd = [
      "ffmpeg", "-y",
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-i", tmpPcm,
      "-codec:a", "libmp3lame",
      "-b:a", "128k",
      tmpMp3,
    ].join(" ");

    execSync(cmd, { stdio: "pipe" });

    const mp3Buffer = fs.readFileSync(tmpMp3);
    if (mp3Buffer.length < 512) {
      throw new Error(`ffmpeg produced suspiciously small MP3: ${mp3Buffer.length} bytes`);
    }
    return mp3Buffer;
  } finally {
    for (const f of [tmpPcm, tmpMp3]) {
      try { fs.unlinkSync(f); } catch (_) { /* best-effort cleanup */ }
    }
  }
}

export async function generateGemini(apiKey, text) {
  assertApiKey(apiKey, "Gemini");
  assertText(text);

  _log("info", "Gemini TTS: requesting audio", { voice: GEMINI_VOICE, model: GEMINI_MODEL });

  const pcmBuffer = await geminiGeneratePcm(apiKey, text);
  _log("info", "Gemini TTS: PCM received, converting to MP3 via ffmpeg", {
    pcmBytes: pcmBuffer.length,
    sampleRate: GEMINI_SAMPLE_RATE,
  });

  const mp3Buffer = pcmToMp3(pcmBuffer, GEMINI_SAMPLE_RATE);
  _log("info", "Gemini TTS: MP3 conversion complete", { mp3Bytes: mp3Buffer.length });

  return { buffer: mp3Buffer, provider: "gemini", voiceName: GEMINI_VOICE, format: "mp3" };
}
