/**
 * Music stage — selects a royalty-free background track based on story mood.
 * Scans the local track library in data/media/music_library/.
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import type { PipelineRun, DirectorPlan, MusicResult } from '../types.js';
import { readdirSync, existsSync } from 'fs';
import path from 'path';

const log = createLogger('pipeline:music');

const MUSIC_LIBRARY_PATH = path.resolve('data/media/music_library');

// Mood → preferred track name substrings (case-insensitive match).
const MOOD_TRACK_MAP: Record<string, string[]> = {
  betrayal: ['tension', 'dark', 'suspense', 'drama'],
  mystery: ['mystery', 'suspense', 'ambient', 'eerie'],
  revenge: ['epic', 'intense', 'power', 'rise'],
  romance: ['soft', 'gentle', 'romantic', 'warm'],
  default: ['ambient', 'soft', 'background'],
};

const SUPPORTED_FORMATS = ['.mp3', '.wav', '.ogg', '.m4a'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getReviewedPlan(checkpoint: Record<string, unknown>): DirectorPlan | null {
  const reviewOutput = checkpoint['review'] as { plan?: DirectorPlan } | undefined;
  const directionOutput = checkpoint['direction'] as { plan?: DirectorPlan } | undefined;
  return reviewOutput?.plan ?? directionOutput?.plan ?? null;
}

function detectMood(plan: DirectorPlan | null): string {
  if (!plan) return 'default';
  const text = [
    plan.title,
    plan.hookLine,
    ...plan.narration,
  ].join(' ').toLowerCase();

  if (/betray|cheat|lie|deceiv/.test(text)) return 'betrayal';
  if (/mystery|secret|hidden|discover/.test(text)) return 'mystery';
  if (/revenge|justice|payback/.test(text)) return 'revenge';
  if (/love|romantic|heart/.test(text)) return 'romance';
  return 'default';
}

function selectTrack(mood: string): string | null {
  if (!existsSync(MUSIC_LIBRARY_PATH)) {
    log.warn({ musicLibraryPath: MUSIC_LIBRARY_PATH }, 'Music library directory not found');
    return null;
  }

  let files: string[];
  try {
    files = readdirSync(MUSIC_LIBRARY_PATH).filter((f) =>
      SUPPORTED_FORMATS.includes(path.extname(f).toLowerCase()),
    );
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to read music library');
    return null;
  }

  if (files.length === 0) {
    log.warn({ mood }, 'Music library is empty');
    return null;
  }

  const keywords = MOOD_TRACK_MAP[mood] ?? MOOD_TRACK_MAP['default'] ?? [];

  // Try to find a track matching mood keywords.
  for (const keyword of keywords) {
    const match = files.find((f) => f.toLowerCase().includes(keyword));
    if (match) {
      return path.join(MUSIC_LIBRARY_PATH, match);
    }
  }

  // Fall back to first available track.
  return path.join(MUSIC_LIBRARY_PATH, files[0] as string);
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runMusic(
  run: PipelineRun,
  checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id }, 'Music stage start');

  const plan = getReviewedPlan(checkpoint);
  const mood = detectMood(plan);
  const trackPath = selectTrack(mood);

  if (!trackPath) {
    log.warn({ runId: run.id, mood }, 'No music track found — continuing without background music');
    const result: MusicResult = { trackPath: '', mood };
    return { music: result, costUsd: 0 };
  }

  const result: MusicResult = { trackPath, mood };
  log.info({ runId: run.id, mood, trackPath }, 'Music stage complete');

  return { music: result, costUsd: 0 };
}
