/**
 * @file _ffmpeg-available.ts
 * @description Helper for tests that spawn real ffmpeg. CI runners don't install
 * ffmpeg (confirmed 2026-07-22: `spawn ffmpeg ENOENT`), so suites exercising real
 * audio processing gate on this and skip rather than hard-fail — same pattern as
 * tests/browser/_browser-available.ts for Chromium. Underscore prefix + no
 * `.test` suffix keeps vitest from collecting this file as a suite.
 */
import { spawnSync } from 'node:child_process';

/** True when an `ffmpeg` binary is on PATH and runs. */
export function ffmpegAvailable(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version']).status === 0;
  } catch {
    return false;
  }
}
