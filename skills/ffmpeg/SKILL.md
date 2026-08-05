---
name: ffmpeg
version: 1.0.0
description: Safety rules and decision logic for media processing with ffmpeg/ffprobe via shell — inspect, convert, trim, merge, resize, compress, extract frames/audio, GIFs, subtitles, overlays. Condensed from grok's ffmpeg skill; full recipes in references/.
author: matrixx0070
tags: [ffmpeg, video, audio, media-processing]
triggers:
  - combine these videos
  - merge my clips
  - join these videos
  - stitch the clips
  - concatenate these files
  - compress video
  - compress this video
  - extract audio
  - extract the audio
  - resize video
  - make a gif
  - make gif
  - remove audio
  - mute the video
  - trim the video
  - trim this video
  - cut the video
  - convert the video
  - ffmpeg
---

# ffmpeg — agent safety rules + decision logic

Full recipes: `skills/ffmpeg/references/recipes.md` (concat, remux, audio
replace, GIF palette, subtitles, overlays, slideshows). Extended doc:
`skills/ffmpeg/references/FULL_SKILL.md`. Read them for anything beyond the
core moves below.

## Safety policy (always)

- **No-overwrite default**: use `-n`; only `-y` when the user explicitly asks
  to overwrite. Never delete the input unless explicitly requested.
- **Temp-file workflow**: write to `${OUT%.*}.tmp.${OUT##*.}`, verify with
  `ffprobe -v error`, then `mv` into place.
- Quote every path. Local files only — never pass user-supplied URLs to
  ffmpeg/ffprobe.
- After producing output, verify with `ffprobe` (exists + streams sane), and
  clean up temp files.

## Inspect first

Probe unknown media before any complex operation:

```bash
ffprobe -v error -show_format -show_streams -of json "$INPUT"
```

## Decision: copy vs re-encode

- **`-c copy`** (fast, lossless) when only trimming on keyframes, remuxing
  containers, or concatenating files with IDENTICAL codecs/resolution/fps.
- **Re-encode** when changing resolution/fps/codec, applying filters, needing
  frame-accurate cuts, or concatenating mismatched inputs.
- Audio: keep AAC as-is (`-c:a copy`); re-encode other codecs to AAC for MP4.

## Web-compatible MP4 defaults

```bash
ffmpeg -n -i "$INPUT" -c:v libx264 -preset medium -crf 23 \
  -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k "$OUTPUT"
```

## Core moves

```bash
# Concat, identical codecs (else re-encode per recipes.md):
printf "file '%s'\n" /abs/a.mp4 /abs/b.mp4 > /tmp/list.txt
ffmpeg -n -f concat -safe 0 -i /tmp/list.txt -c copy "$OUTPUT"

# Trim (frame-accurate, re-encode):
ffmpeg -n -ss 00:00:05 -to 00:00:12 -i "$INPUT" -c:v libx264 -c:a aac "$OUTPUT"

# Resize to width 1280 (height auto, even):
ffmpeg -n -i "$INPUT" -vf "scale=1280:-2" -c:a copy "$OUTPUT"

# Single frame at 3s:
ffmpeg -n -ss 3 -i "$INPUT" -frames:v 1 "$OUTPUT.jpg"

# Extract audio without re-encoding (match container to codec):
ffmpeg -n -i "$INPUT" -vn -c:a copy "$OUTPUT.m4a"
```

## Common failure modes

- Concat artifacts/desync → inputs weren't identical; re-encode instead of
  `-c copy`.
- "height/width not divisible by 2" → use `-2` in scale expressions.
- No audio in output → check `-map`; ffmpeg keeps only one stream per type by
  default.
- Player won't open MP4 → missing `yuv420p`/`faststart` (see defaults above).

## Agent behavior

- State what the command will do in one line before running it.
- Prefer one ffmpeg invocation over chains; avoid needless generational
  re-encodes.
- sudo-ai also has `media.video-edit` (structured cut/trim/merge) — prefer it
  for simple cases; drop to raw ffmpeg for anything it doesn't cover.
