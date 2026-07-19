# Voice at boot (F96) — verdict: PARK-until-F94-unparks

**Verdict (2026-07-19, Phase 4.3):** PARK. Daemon-level voice-engine init at boot
is **not wired** and should stay parked. F96's stated purpose is to feed F93/F94
(the video/audio pipelines), which are **PARKED BY FRANK** — so its dependent
demand does not exist yet. Critically, voice is **NOT dead**: it already has an
independent live consumer (Telegram voice replies) via a lazy, tool-gated path,
so no boot-time warmup is needed for that consumer to work.

## What exists

- Full voice engine under `src/core/voice/`: `VoiceEngine` (orchestration),
  `KokoroLocalTTS` (`kokoro.ts`), `WhisperLocalSTT` (`whisper-local.ts`),
  `SpeechToText`/`TextToSpeech` wrappers, plus the `voice-engine` meta tool.
- Consumers today: the `meta` voice tool (tool-gated), and
  `src/core/channels/telegram.ts`.

## Independent live consumer (why voice is not dead)

`src/core/channels/telegram.ts` does auto voice-in → voice-out:

- STT/TTS are **lazy-loaded** ("created once on first use", telegram.ts:223) —
  the expensive model load is deferred to first voice message, NOT boot.
- `SUDO_TELEGRAM_VOICE_REPLY` is **default ON** (telegram.ts:271-272: enabled
  unless set to `0`/`false`). A voice note in → the next non-empty text reply is
  synthesised with Kokoro TTS and sent back as a voice note.

So the one live voice consumer works correctly **without** any boot-level init.

## Asset status on this host

- Whisper: `~/.cache/whisper/base.pt` present (~145 MB). Kokoro/Whisper ONNX
  weights are otherwise **downloaded on first use** and cached by
  `@huggingface/transformers` (see `kokoro.ts` / `whisper-local.ts` docstrings) —
  i.e. cache-on-demand, not boot-provisioned.
- Defaults: Kokoro `onnx-community/Kokoro-82M-v1.0-ONNX` (q8, cpu, `af_heart`);
  Whisper `onnx-community/whisper-base` (q8, cpu). Both toggleable via
  `SUDO_KOKORO_TTS=0` / `SUDO_WHISPER_STT=0`.

## Why boot-init is not warranted now

- **Cost**: a boot warmup forces a model-weight download + ONNX session init at
  daemon start for every process — added cold-start latency and (first-run)
  bandwidth — for **no live benefit**, since the only consumer (Telegram) is
  already served by the lazy path.
- **No dependent demand**: the pipelines F96 feeds (F93 video / F94 audio) are
  parked by Frank. Boot-provisioning assets ahead of those pipelines is premature.
- **No new spend**: honoring the campaign's no-new-spend rule.

## Unpark trigger

Wire daemon-level voice init + asset provisioning **when F94 (DIY audio-overview
pipeline) is unparked** and needs pre-warmed TTS at boot, OR if a new consumer
appears that cannot tolerate first-use cold start. Until then: lazy, tool-gated,
Telegram-live — no boot init.
