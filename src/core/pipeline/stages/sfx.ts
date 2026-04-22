/**
 * SFX stage — applies the hook_tension_reveal preset to scene timing.
 * Resolves SFX file paths from the local sfx library.
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import type { PipelineRun, SfxResult } from '../types.js';
import { existsSync } from 'fs';
import path from 'path';

const log = createLogger('pipeline:sfx');

const SFX_LIBRARY_PATH = path.resolve('data/media/sfx_library');

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

interface SfxCue {
  name: string;
  file: string;
  atSecond: number;
  volume: number;
}

const PRESETS: Record<string, SfxCue[]> = {
  hook_tension_reveal: [
    { name: 'whoosh_open', file: 'whoosh_open.mp3', atSecond: 0, volume: 0.7 },
    { name: 'heartbeat', file: 'heartbeat.mp3', atSecond: 2, volume: 0.5 },
    { name: 'tension_rise', file: 'tension_rise.mp3', atSecond: 8, volume: 0.6 },
    { name: 'sting', file: 'sting.mp3', atSecond: 11, volume: 0.8 },
    { name: 'reveal_boom', file: 'reveal_boom.mp3', atSecond: 14, volume: 0.9 },
    { name: 'whoosh_close', file: 'whoosh_close.mp3', atSecond: 28, volume: 0.5 },
  ],
  minimal: [
    { name: 'whoosh_open', file: 'whoosh_open.mp3', atSecond: 0, volume: 0.6 },
    { name: 'sting', file: 'sting.mp3', atSecond: 14, volume: 0.7 },
  ],
};

const DEFAULT_PRESET = 'hook_tension_reveal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSfxPaths(cues: SfxCue[]): string[] {
  const paths: string[] = [];
  for (const cue of cues) {
    const filePath = path.join(SFX_LIBRARY_PATH, cue.file);
    if (existsSync(filePath)) {
      paths.push(filePath);
    } else {
      log.warn({ file: cue.file, filePath }, 'SFX file not found in library — skipping');
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runSfx(
  run: PipelineRun,
  _checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id, preset: DEFAULT_PRESET }, 'SFX stage start');

  if (!existsSync(SFX_LIBRARY_PATH)) {
    log.warn({ sfxLibraryPath: SFX_LIBRARY_PATH }, 'SFX library directory not found — continuing without SFX');
    const result: SfxResult = { sfxPaths: [], preset: DEFAULT_PRESET };
    return { sfx: result, costUsd: 0 };
  }

  const preset = PRESETS[DEFAULT_PRESET];
  if (!preset) {
    throw new PipelineError(
      `Unknown SFX preset: ${DEFAULT_PRESET}`,
      'pipeline_sfx_unknown_preset',
      { preset: DEFAULT_PRESET },
    );
  }

  const sfxPaths = resolveSfxPaths(preset);

  const result: SfxResult = {
    sfxPaths,
    preset: DEFAULT_PRESET,
  };

  log.info(
    { runId: run.id, sfxCount: sfxPaths.length, preset: DEFAULT_PRESET },
    'SFX stage complete',
  );

  return { sfx: result, costUsd: 0 };
}
