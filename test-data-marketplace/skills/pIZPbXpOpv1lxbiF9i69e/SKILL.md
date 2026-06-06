---
name: tts
description: Convert text to speech audio using OpenAI TTS or ElevenLabs and save as an audio file.
trigger: /tts, text to speech, speak this, generate audio, read aloud, voice synthesis
allowed-tools: [web.fetch]
---

# Skill: Text-to-Speech

## Purpose
Generate spoken audio from text using OpenAI TTS or ElevenLabs API.
Saves the output as an `.mp3` file and reports the file path.

## When to use
- User wants to convert text, a document, or a message into audio
- User wants to generate a voiceover for a video or presentation
- User wants to hear content read aloud as a file they can play
- User wants to create audio content in a specific voice or language

## How to use

1. Check that `TTS_API_KEY` is set in the environment. If missing, inform the user and stop.
   Optionally check `TTS_PROVIDER` (default: `openai`; alternative: `elevenlabs`).

2. Extract text from `$ARGUMENTS`. If text is long (>4096 chars), warn the user that
   OpenAI TTS splits at 4096 chars; offer to split into multiple files.

3. **OpenAI TTS** (default, `TTS_PROVIDER=openai`):
   - POST `https://api.openai.com/v1/audio/speech`
   - Headers: `Authorization: Bearer $TTS_API_KEY`
   - Body: `{ "model": "tts-1", "input": "<text>", "voice": "alloy", "response_format": "mp3" }`
   - Available voices: alloy, echo, fable, onyx, nova, shimmer
   - Save binary response to `~/tts-output-<timestamp>.mp3`

4. **ElevenLabs** (`TTS_PROVIDER=elevenlabs`):
   - POST `https://api.elevenlabs.io/v1/text-to-speech/<voice_id>`
   - Headers: `xi-api-key: $TTS_API_KEY`, `Content-Type: application/json`
   - Body: `{ "text": "<text>", "model_id": "eleven_monolingual_v1" }`
   - Default voice ID: `21m00Tcm4TlvDq8ikWAM` (Rachel). Override with `TTS_VOICE_ID` env var.
   - Save binary response to `~/tts-output-<timestamp>.mp3`

5. Confirm completion: report the saved file path and duration estimate
   (approx. 150 words per minute).

6. Offer to adjust voice, speed, or provider if the user is not satisfied.

## Requirements
- `TTS_API_KEY` — OpenAI API key (sk-...) or ElevenLabs API key.
- `TTS_PROVIDER` — optional, `openai` (default) or `elevenlabs`.
- `TTS_VOICE_ID` — optional ElevenLabs voice ID override.
- Output directory must be writable (default: home directory).

## Example
```
/tts "Welcome to the SUDO-AI assistant. How can I help you today?"
/tts voice:nova "Chapter one. It was a dark and stormy night."
/tts provider:elevenlabs "Hello, this is a test of the ElevenLabs integration."
```
