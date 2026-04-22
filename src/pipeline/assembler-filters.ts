/**
 * @file assembler-filters.ts
 * Internal helpers: ffmpeg filter_complex string builders for the video assembler.
 * Not part of the public pipeline API — imported only by video-assembler.ts.
 */

import type { SceneAssets, SceneTimestamp } from './types.js';

// ---------------------------------------------------------------------------
// Constants (shared with assembler)
// ---------------------------------------------------------------------------

export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;
export const OUTPUT_FPS = 30;
export const FALLBACK_SCENE_DURATION = 4;
export const SUBTITLE_FONT_SIZE = 48;
export const SUBTITLE_COLOR = 'white';
export const SUBTITLE_BOX_COLOR = '0x000000@0.55';
export const SUBTITLE_BOX_BORDER = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe use as an ffmpeg drawtext `text=` value.
 * Handles backslashes, single quotes, and colons.
 */
function escapeDt(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

// ---------------------------------------------------------------------------
// Filter builders
// ---------------------------------------------------------------------------

/**
 * Build a zoompan filter string for one scene image (Ken Burns effect).
 * The output duration equals `durationS` seconds at OUTPUT_FPS.
 *
 * @param inputLabel  - ffmpeg stream label for the input (e.g. "[0:v]").
 * @param outputLabel - Label for the resulting stream (e.g. "[z0]").
 * @param durationS   - Scene display duration in seconds.
 * @param sceneIdx    - 0-based index; controls zoom/pan direction alternation.
 */
export function buildZoompanFilter(
  inputLabel: string,
  outputLabel: string,
  durationS: number,
  sceneIdx: number,
): string {
  const frames = Math.max(1, Math.round(durationS * OUTPUT_FPS));
  const zoomExpr =
    sceneIdx % 2 === 0
      ? `min(zoom+0.0008,1.15)`
      : `if(lte(zoom,1.0),1.05,max(zoom-0.0008,1.0))`;
  const xExpr =
    sceneIdx % 4 < 2
      ? 'iw/2-(iw/zoom/2)'
      : 'iw/2-(iw/zoom/2)+((iw/zoom/2)*0.02)';
  const yExpr = 'ih/2-(ih/zoom/2)';

  return (
    `${inputLabel}scale=${OUTPUT_WIDTH * 2}:${OUTPUT_HEIGHT * 2},` +
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':` +
    `d=${frames}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${OUTPUT_FPS}${outputLabel}`
  );
}

/**
 * Build a drawtext filter that overlays one scene's narration subtitle.
 * The text is visible only within the scene's timestamp window.
 *
 * @param inputLabel  - Incoming video stream label.
 * @param outputLabel - Outgoing video stream label.
 * @param text        - Narration text to render.
 * @param ts          - Timestamp window for enable expression.
 */
export function buildSubtitleFilter(
  inputLabel: string,
  outputLabel: string,
  text: string,
  ts: SceneTimestamp,
): string {
  const safeText = escapeDt(text);
  return (
    `${inputLabel}drawtext=` +
    `text='${safeText}':` +
    `fontsize=${SUBTITLE_FONT_SIZE}:` +
    `fontcolor=${SUBTITLE_COLOR}:` +
    `box=1:boxcolor=${SUBTITLE_BOX_COLOR}:boxborderw=${SUBTITLE_BOX_BORDER}:` +
    `x=(w-text_w)/2:y=h-th-80:` +
    `enable='between(t,${ts.startSeconds.toFixed(3)},${ts.endSeconds.toFixed(3)})'` +
    `${outputLabel}`
  );
}

/**
 * Resolve scene display duration from timestamp array; falls back to default.
 */
export function resolveSceneDuration(
  sceneIndex: number,
  timestamps: SceneTimestamp[],
): number {
  const ts = timestamps.find((t) => t.sceneIndex === sceneIndex);
  if (!ts) return FALLBACK_SCENE_DURATION;
  const dur = ts.endSeconds - ts.startSeconds;
  return dur > 0 ? dur : FALLBACK_SCENE_DURATION;
}

/**
 * Build the complete filter_complex string for the main ffmpeg pass.
 * Stages: zoompan per scene → concat → chained drawtext subtitles → voice volume.
 *
 * @param validAssets    - Scene assets that have a confirmed imagePath.
 * @param timestamps     - Per-scene timing windows.
 * @param scenes         - Script scenes providing narration text.
 * @param voiceInputIdx  - ffmpeg input index of the voice audio file.
 */
export function buildFilterComplex(
  validAssets: (SceneAssets & { imagePath: string })[],
  timestamps: SceneTimestamp[],
  scenes: Array<{ index: number; narration: string }>,
  voiceInputIdx: number,
): string {
  const parts: string[] = [];

  // 1) Ken Burns zoompan per scene
  const zoomedLabels: string[] = [];
  for (let i = 0; i < validAssets.length; i++) {
    const asset = validAssets[i]!;
    const dur = resolveSceneDuration(asset.sceneIndex, timestamps);
    const outLabel = `[z${i}]`;
    parts.push(buildZoompanFilter(`[${i}:v]`, outLabel, dur, i));
    zoomedLabels.push(outLabel);
  }

  // 2) Concatenate all zoomed segments
  parts.push(`${zoomedLabels.join('')}concat=n=${validAssets.length}:v=1:a=0[vid_raw]`);

  // 3) Chain drawtext subtitle filters
  let curLabel = '[vid_raw]';
  let dtCount = 0;
  for (let i = 0; i < validAssets.length; i++) {
    const asset = validAssets[i]!;
    const sceneScript = scenes.find((s) => s.index === asset.sceneIndex);
    const ts = timestamps.find((t) => t.sceneIndex === asset.sceneIndex);
    if (!sceneScript || !ts) continue;

    const isLast = i === validAssets.length - 1;
    const outLabel = isLast ? '[vid]' : `[vid_dt${dtCount}]`;
    parts.push(buildSubtitleFilter(curLabel, outLabel, sceneScript.narration, ts));
    curLabel = outLabel;
    dtCount++;
  }

  // Safety: if no subtitles were applied, alias vid_raw → vid
  if (curLabel === '[vid_raw]') {
    parts.push('[vid_raw]null[vid]');
  }

  // 4) Voice audio at full volume
  parts.push(`[${voiceInputIdx}:a]volume=1.0[aout]`);

  return parts.join('; ');
}
