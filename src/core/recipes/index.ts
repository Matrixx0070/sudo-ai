/**
 * @file recipes/index.ts
 * @description Barrel export for recipes module.
 *
 * Wave 10 — Builder 3 (Config + Ops + UX)
 */

export { RecipeComposer } from './recipe-composer.js';
export type {
  Recipe,
  RecipeOperatorRef,
  Config5Pillar,
} from './recipe-types.js';
export type {
  RecipeLoadResult,
  RecipeApplyResult,
} from './recipe-types.js';
