/**
 * @file recipes/recipe-types.ts
 * @description Re-exports Recipe and related types from wave10-types.
 *
 * Wave 10 — Builder 3 (Config + Ops + UX)
 * Import from this file for all recipe-related type usage.
 */

export type {
  Recipe,
  RecipeOperatorRef,
  Config5Pillar,
} from '../shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Runtime helper types
// ---------------------------------------------------------------------------

/** Result of loading a recipe TOML file. */
export interface RecipeLoadResult {
  /** Absolute path to the TOML file. */
  filePath: string;
  /** Parsed recipe, or null if parsing failed. */
  recipe: import('../shared/wave10-types.js').Recipe | null;
  /** Error message if parsing failed. */
  error?: string;
}

/** Summary of what was applied when materializing a recipe. */
export interface RecipeApplyResult {
  /** Recipe that was applied. */
  recipe: import('../shared/wave10-types.js').Recipe;
  /** Keys of Config5Pillar sections that were overridden. */
  appliedSections: string[];
  /** Operators activated (enabled override). */
  activatedOperators: string[];
  /** Channels activated by the recipe. */
  channels: string[];
}
