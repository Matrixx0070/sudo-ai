/**
 * @file index.ts
 * @description Barrel export for the emotional-memory subsystem.
 *
 * Public surface:
 *   - EmotionalStateManager  — tracks and persists emotional valence
 *   - SomaticMarkerStore     — CRUD for somatic trigger→emotion markers
 *   - analyzeEmotionalContent — rule-based text → EmotionalValence function
 *   - SomaticMarker          — core type for marker records
 */

export { analyzeEmotionalContent } from './analyzer.js';
export { EmotionalStateManager } from './state.js';
export { SomaticMarkerStore } from './markers.js';
export type { SomaticMarker } from './types.js';
