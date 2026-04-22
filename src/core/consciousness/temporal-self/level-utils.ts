/**
 * @file level-utils.ts
 * @description Pure helper utilities for capability level label conversion
 * and progression used by the temporal-self subsystem.
 */

// ---------------------------------------------------------------------------
// Level progression table
// ---------------------------------------------------------------------------

/** Ordered list of capability level labels from lowest to highest. */
export const LEVEL_PROGRESSION: readonly string[] = [
  'novice',
  'developing',
  'competent',
  'proficient',
  'expert',
];

/**
 * Return the next level label above `current`, or 'expert' if already maxed.
 *
 * @param current - Current text-level label.
 * @returns Next level label in the progression.
 */
export function nextLevel(current: string): string {
  const idx = LEVEL_PROGRESSION.indexOf(current);
  if (idx === -1 || idx >= LEVEL_PROGRESSION.length - 1) return 'expert';
  return LEVEL_PROGRESSION[idx + 1] as string;
}

/**
 * Convert a numeric 0..1 capability level to a text label.
 *
 * @param level - Numeric level value in [0, 1].
 * @returns Corresponding text-level label.
 */
export function numericToLabel(level: number): string {
  if (level < 0.2) return 'novice';
  if (level < 0.4) return 'developing';
  if (level < 0.6) return 'competent';
  if (level < 0.8) return 'proficient';
  return 'expert';
}

/**
 * Compare two text-level labels and return the order difference.
 *
 * @param a - First label.
 * @param b - Second label.
 * @returns Positive if a > b, negative if a < b, 0 if equal or unknown.
 */
export function compareLevels(a: string, b: string): number {
  const ai = LEVEL_PROGRESSION.indexOf(a);
  const bi = LEVEL_PROGRESSION.indexOf(b);
  // Treat unknown labels as 0 (novice index)
  return (ai === -1 ? 0 : ai) - (bi === -1 ? 0 : bi);
}
