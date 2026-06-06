---
name: video-extract
description: Extract audio tracks or video frames from media files using ffmpeg.
trigger: /video-extract, extract audio, extract frames, video to mp3, ffmpeg extract, get audio from video
allowed-tools: [exec.run]
---

# Skill: Video Extract

## Purpose
Extract audio tracks (as MP3/WAV) or image frames from video files using `ffmpeg`.
Useful for transcription prep, thumbnail generation, or media processing pipelines.

## When to use
- User wants to extract audio from a video for transcription or playback
- User wants to grab a specific frame or set of frames from a video
- User wants to convert a video to audio-only format
- Automated pipeline needs audio/frames from a media file

## How to use

1. Verify `ffmpeg` is installed: `exec.run: ffmpeg -version`
   If missing: suggest `apt install ffmpeg` (Linux) or `brew install ffmpeg` (macOS).

2. Resolve the input file path from `$ARGUMENTS`. Confirm the file exists.

3. **Extract full audio track as MP3:**
   ```
   ffmpeg -i "<input.mp4>" -q:a 0 -map a "<output.mp3>"
   ```
   Output path: same directory as input, same filename with `.mp3` extension.

4. **Extract audio as WAV (for transcription):**
   ```
   ffmpeg -i "<input.mp4>" -ar 16000 -ac 1 -c:a pcm_s16le "<output.wav>"
   ```
   16kHz mono WAV is the standard format for Whisper transcription.

5. **Extract a single frame at a timestamp:**
   ```
   ffmpeg -i "<input.mp4>" -ss <HH:MM:SS> -frames:v 1 "<output.png>"
   ```
   Example: `-ss 00:01:30` extracts frame at 1 minute 30 seconds.

6. **Extract frames at regular intervals:**
   ```
   ffmpeg -i "<input.mp4>" -vf fps=1 "<output_dir>/frame-%04d.png"
   ```
   `fps=1` = one frame per second. Adjust as needed (e.g., `fps=0.5` for one every 2 sec).

7. **Extract a clip (trim) as audio or video:**
   ```
   ffmpeg -i "<input.mp4>" -ss <start> -to <end> -c copy "<output.mp4>"
   ```

8. **Get media info (duration, codec, resolution):**
   ```
   ffprobe -v quiet -print_format json -show_format -show_streams "<input.mp4>"
   ```

9. Confirm output file(s) created and report their paths and sizes.

## Requirements
- `ffmpeg` and `ffprobe` installed (usually bundled together).
  - Linux: `apt install ffmpeg`
  - macOS: `brew install ffmpeg`
- Input file must be accessible on the local filesystem.
- Sufficient disk space for output files (audio ≈ 1MB/min, frames vary by resolution).

## Example
```
/video-extract audio from lecture.mp4
/video-extract frame at 00:02:30 from demo.mp4
/video-extract frames every 5 seconds from timelapse.mp4
/video-extract clip from 00:01:00 to 00:02:00 from interview.mp4
```
